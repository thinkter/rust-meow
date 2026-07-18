package bridge

import (
	"bytes"
	"encoding/binary"
	"testing"

	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
)

func TestCodecRoundTrip(t *testing.T) {
	var buffer bytes.Buffer
	c := NewCodec(&buffer, &buffer)
	want := &bridgev1.Envelope{ProtocolVersion: 1, RequestId: 42, Body: &bridgev1.Envelope_Request{Request: &bridgev1.RpcRequest{Request: &bridgev1.RpcRequest_Hello{Hello: &bridgev1.HelloRequest{DesktopVersion: "test"}}}}}
	if err := c.Write(want); err != nil {
		t.Fatal(err)
	}
	got, err := c.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got.GetRequest().GetHello().GetDesktopVersion() != "test" {
		t.Fatalf("got=%v", got)
	}
}

func TestCodecRejectsOversize(t *testing.T) {
	var buffer bytes.Buffer
	var h [4]byte
	binary.BigEndian.PutUint32(h[:], MaxFrameSize+1)
	buffer.Write(h[:])
	if _, err := NewCodec(&buffer, &buffer).Read(); err == nil {
		t.Fatal("expected error")
	}
}
