package bridge

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
	"google.golang.org/protobuf/proto"
)

const MaxFrameSize = 8 << 20

type Codec struct {
	reader    io.Reader
	writer    io.Writer
	writeMu   sync.Mutex
	closeOnce sync.Once
}

func NewCodec(reader io.Reader, writer io.Writer) *Codec {
	return &Codec{reader: reader, writer: writer}
}

func (c *Codec) Read() (*bridgev1.Envelope, error) {
	var header [4]byte
	if _, err := io.ReadFull(c.reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > MaxFrameSize {
		return nil, fmt.Errorf("invalid frame size %d", size)
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(c.reader, data); err != nil {
		return nil, err
	}
	var envelope bridgev1.Envelope
	if err := proto.Unmarshal(data, &envelope); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	if envelope.GetRequest() == nil {
		return nil, errors.New("desktop frame is not a request")
	}
	return &envelope, nil
}

func (c *Codec) Write(envelope *bridgev1.Envelope) error {
	data, err := proto.Marshal(envelope)
	if err != nil {
		return err
	}
	if len(data) > MaxFrameSize {
		return fmt.Errorf("frame exceeds %d bytes", MaxFrameSize)
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(data)))
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if _, err = c.writer.Write(header[:]); err != nil {
		return err
	}
	_, err = c.writer.Write(data)
	return err
}

// Close interrupts blocked bridge I/O after a terminal framing/write failure.
// The production codec owns only the sidecar's stdin/stdout handles; buffers
// used by tests do not implement io.Closer and are left untouched.
func (c *Codec) Close() error {
	var result error
	c.closeOnce.Do(func() {
		if closer, ok := c.reader.(io.Closer); ok {
			result = errors.Join(result, closer.Close())
		}
		if closer, ok := c.writer.(io.Closer); ok {
			result = errors.Join(result, closer.Close())
		}
	})
	return result
}
