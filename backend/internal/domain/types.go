package domain

import "time"

type Chat struct {
	JID             string
	AddressJID      string
	Name            string
	LastMessageID   string
	LastMessageText string
	LastMessageAt   time.Time
	UnreadCount     int64
	MutedUntil      time.Time
	Archived        bool
}

type MessageSearchHit struct {
	Chat       Chat
	MessageID  string
	SenderJID  string
	Text       string
	Kind       string
	Timestamp  time.Time
	FromMe     bool
	SearchText string
	Score      int
}

type MessageWindow struct {
	Items    []Message
	HasOlder bool
	HasNewer bool
	AnchorID string
}

type Message struct {
	ID           string
	ChatJID      string
	TransportJID string
	SenderJID    string
	Text         string
	Timestamp    time.Time
	FromMe       bool
	Status       MessageStatus
	Kind         string
	ReplyToID    string
	EditedAt     time.Time
	Revoked      bool
	Reactions    []Reaction
	Image        *Image
	Attachment   *Attachment
	Contacts     []Contact
	Location     *Location
	LinkPreview  *LinkPreview
	Poll         *Poll
}

type Poll struct {
	Question               string
	Options                []PollOption
	SelectableOptionsCount uint32
	TotalVoters            uint32
}

type PollOption struct {
	Name         string
	VoteCount    uint32
	SelectedByMe bool
}

type PollVote struct {
	ChatJID, PollMessageID, VoterJID string
	SelectedOptions                  []string
	Timestamp                        time.Time
	FromMe                           bool
}

type PinnedMessage struct {
	MessageID string
	PinnedAt  time.Time
	PinnedBy  string
	Message   *Message
}

type LinkPreview struct {
	URL             string
	Title           string
	Description     string
	JPEGThumbnail   []byte
	ThumbnailWidth  uint32
	ThumbnailHeight uint32
}

type Image struct {
	Caption       string
	MIMEType      string
	LocalPath     string
	DirectPath    string
	MediaKey      []byte
	FileSHA256    []byte
	FileEncSHA256 []byte
	Width         uint32
	Height        uint32
	FileSize      uint64
	Animated      bool
}

// Attachment describes media that is not rendered as an inline image. The
// cryptographic fields are retained so media can be fetched lazily instead of
// downloading every attachment while history is syncing.
type Attachment struct {
	Caption         string
	MIMEType        string
	FileName        string
	LocalPath       string
	DirectPath      string
	MediaKey        []byte
	FileSHA256      []byte
	FileEncSHA256   []byte
	Width           uint32
	Height          uint32
	FileSize        uint64
	DurationSeconds uint32
	Animated        bool
	VoiceNote       bool
}

type Contact struct {
	DisplayName string
	VCard       string
}

type Location struct {
	Latitude  float64
	Longitude float64
	Name      string
	Address   string
	URL       string
	Live      bool
}

// StickerCandidate is a deduplicated sticker sourced from local message
// history: one representative message stands in for every message carrying
// the same plaintext content hash.
type StickerCandidate struct {
	ID          string // hex(FileSHA256)
	ChatJID     string
	MessageID   string
	MIMEType    string
	Width       uint32
	Height      uint32
	Animated    bool
	FromMe      bool
	TimestampMs int64
}

// FavoriteSticker is a sticker WhatsApp synced through app-state as
// favourited on another linked device. It has no associated local message,
// only the raw media descriptor needed to download it directly.
type FavoriteSticker struct {
	ID            string // hex(FileEncSHA256): no plaintext hash is ever synced
	MIMEType      string
	DirectPath    string
	MediaKey      []byte
	FileEncSHA256 []byte
	Width         uint32
	Height        uint32
	Animated      bool
	FileSize      uint64
	LocalPath     string
	UpdatedAtMs   int64
}

type Reaction struct {
	ChatJID   string
	MessageID string
	SenderJID string
	Emoji     string
	Timestamp time.Time
	FromMe    bool
}

type ReactionRepairJob struct {
	ChatJID, AnchorMessageID string
	TransportJID             string
	AnchorTimestamp          time.Time
	AnchorFromMe             bool
	Attempts                 uint32
}

type LegacyReactionReplay struct {
	ChatJID, EventMessageID, SenderJID string
	TransportJID                       string
	Timestamp                          time.Time
	FromMe                             bool
	Attempts                           uint32
}

type MessageStatus int32

const (
	StatusUnspecified MessageStatus = iota
	StatusPending
	StatusSent
	StatusDelivered
	StatusRead
	StatusFailed
)

type Page[T any] struct {
	Items      []T
	NextCursor string
}
