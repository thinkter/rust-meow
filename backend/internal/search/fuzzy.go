package search

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

const NoMatch = -1

type Matcher struct {
	query string
	runes []rune
}

func New(query string) Matcher {
	normalized := Normalize(query)
	return Matcher{query: normalized, runes: []rune(normalized)}
}

func Normalize(value string) string {
	decomposed := norm.NFD.String(strings.ToLower(strings.TrimSpace(value)))
	var out strings.Builder
	space := false
	for _, r := range decomposed {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if unicode.IsSpace(r) {
			space = out.Len() > 0
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(r)
	}
	return out.String()
}

func Digits(value string) string {
	var out strings.Builder
	for _, r := range value {
		if unicode.IsDigit(r) {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func (m Matcher) Query() string { return m.query }

func (m Matcher) Score(candidate string) int {
	if m.query == "" {
		return NoMatch
	}
	candidate = Normalize(candidate)
	if candidate == "" {
		return NoMatch
	}
	if candidate == m.query {
		return 1000
	}
	if strings.HasPrefix(candidate, m.query) {
		return 930
	}
	for _, word := range strings.Fields(candidate) {
		if word == m.query {
			return 910
		}
		if strings.HasPrefix(word, m.query) {
			return 880
		}
	}
	if strings.Contains(candidate, m.query) {
		return 820
	}
	bestEdit := NoMatch
	for _, part := range append(strings.Fields(candidate), candidate) {
		partRunes := []rune(part)
		lengthDelta := len(partRunes) - len(m.runes)
		if lengthDelta < 0 {
			lengthDelta = -lengthDelta
		}
		threshold := len(m.runes) / 4
		if threshold < 1 {
			threshold = 1
		}
		if lengthDelta > threshold {
			continue
		}
		if distance := damerauLevenshtein(m.runes, partRunes, threshold); distance <= threshold {
			score := 760 - distance*80 - lengthDelta*10
			if score > bestEdit {
				bestEdit = score
			}
		}
	}
	if bestEdit != NoMatch {
		return bestEdit
	}
	if score := subsequenceScore(m.runes, []rune(candidate)); score != NoMatch {
		return score
	}
	return NoMatch
}

func subsequenceScore(query, candidate []rune) int {
	if len(query) == 0 || len(query) > len(candidate) {
		return NoMatch
	}
	matched, first, previous, gaps := 0, -1, -1, 0
	for index, r := range candidate {
		if r != query[matched] {
			continue
		}
		if first == -1 {
			first = index
		}
		if previous >= 0 {
			gaps += index - previous - 1
		}
		previous = index
		matched++
		if matched == len(query) {
			return 650 - first*4 - gaps*8
		}
	}
	return NoMatch
}

func damerauLevenshtein(left, right []rune, cutoff int) int {
	if len(left) == 0 {
		return len(right)
	}
	previousPrevious := make([]int, len(right)+1)
	previous := make([]int, len(right)+1)
	current := make([]int, len(right)+1)
	for index := range previous {
		previous[index] = index
	}
	for i := 1; i <= len(left); i++ {
		current[0] = i
		rowMin := current[0]
		for j := 1; j <= len(right); j++ {
			cost := 0
			if left[i-1] != right[j-1] {
				cost = 1
			}
			current[j] = min(previous[j]+1, current[j-1]+1, previous[j-1]+cost)
			if i > 1 && j > 1 && left[i-1] == right[j-2] && left[i-2] == right[j-1] {
				current[j] = min(current[j], previousPrevious[j-2]+1)
			}
			rowMin = min(rowMin, current[j])
		}
		if rowMin > cutoff {
			return cutoff + 1
		}
		previousPrevious, previous, current = previous, current, previousPrevious
	}
	return previous[len(right)]
}
