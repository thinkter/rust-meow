package search

import "testing"

func TestMatcherHandlesTyposPartialsAndDiacritics(t *testing.T) {
	tests := []struct {
		query, candidate string
	}{
		{"jsoe", "José"},
		{"mfrnd", "Meow Friend"},
		{"road", "Quarterly roadmap"},
		{"alice", "Alice"},
	}
	for _, test := range tests {
		if score := New(test.query).Score(test.candidate); score == NoMatch {
			t.Errorf("%q did not match %q", test.query, test.candidate)
		}
	}
	if score := New("kitten").Score("quarterly roadmap"); score != NoMatch {
		t.Fatalf("unrelated values matched with score %d", score)
	}
}

func TestDigitsNormalizesFormattedPhoneNumbers(t *testing.T) {
	if got := Digits("+91 (98765) 43210"); got != "919876543210" {
		t.Fatalf("digits=%q", got)
	}
	if New("7654").Score(Digits("+91 98765 43210")) == NoMatch {
		t.Fatal("phone fragment did not match")
	}
}
