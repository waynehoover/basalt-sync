package wire

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// The retryable column of the error table in docs/protocol.md is what
// Retryable returns. Read from the doc rather than restated here, so the two
// cannot drift without this failing.
func TestI2RetryableMatchesTheProtocolDoc(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/protocol.md")
	if err != nil {
		t.Skipf("protocol.md not beside the source: %v", err)
	}
	row := regexp.MustCompile("(?m)^\\| `([a-z]+)` \\| [^|]* \\| (yes|no)[^|]* \\| ")
	rows := row.FindAllStringSubmatch(string(doc), -1)
	if len(rows) < 10 {
		t.Fatalf("found %d error rows in the doc, expected the whole table", len(rows))
	}
	seen := map[string]bool{}
	for _, m := range rows {
		code, want := m[1], m[2] == "yes"
		seen[code] = true
		if got := Retryable(code); got != want {
			t.Errorf("Retryable(%q) = %v, the doc says %v", code, got, want)
		}
	}
	for _, code := range []string{CodeProto, CodeAuth, CodeCursor, CodeRotated, CodeBusy, CodeProtoState,
		CodeBadChunk, CodeBadEntry, CodeBadName, CodeToolarge, CodeNoSpace, CodeNoUID, CodeNoContent,
		CodeNoChunk, CodeNoDevice, CodeInternal} {
		if !seen[code] {
			t.Errorf("code %q has no row in the doc's error table", code)
		}
	}
}

// Every error carries retryable, whatever else it carries: id only when it
// answers a request, retryAfterMs only when there is a hint to give.
func TestI2ErrShapes(t *testing.T) {
	answering := Error(CodeNoUID, "m")
	answering.ID = 7
	if b, _ := json.Marshal(answering); string(b) != `{"res":"err","id":7,"code":"nouid","msg":"m","retryable":false}` {
		t.Fatalf("the shape of an error answering a request: %s", b)
	}
	unsolicited := Error(CodeBusy, "m")
	unsolicited.RetryAfterMs = 5000
	b, _ := json.Marshal(unsolicited)
	if strings.Contains(string(b), `"id"`) || !strings.Contains(string(b), `"retryAfterMs":5000`) ||
		!strings.Contains(string(b), `"retryable":true`) {
		t.Fatalf("the shape of an unsolicited error: %s", b)
	}
	// Nothing can build an error without the verdict, because the field is not
	// omitted and not a pointer: the zero value is a stated "do not retry".
	if b, _ := json.Marshal(Err{Res: "err", Code: CodeAuth, Msg: "m"}); !strings.Contains(string(b), `"retryable":false`) {
		t.Fatalf("an error was built with no retryable: %s", b)
	}
}

// esc is a JSON string escape for one UTF-16 code unit. It is built rather than
// written out, so each case below says which unit it means without depending
// on anything between this file and the compiler leaving that sequence alone.
func esc(unit string) string { return string(rune(0x5c)) + "u" + unit }

// raw is bytes as they would arrive on the wire, which need not be UTF-8.
func raw(b ...byte) string { return string(b) }

// A text frame that JSON decoding would change is refused before it is
// decoded, and one that only looks unusual is not.
//
// Go's decoder turns invalid UTF-8, and an escape naming one half of a
// surrogate pair without the other, into U+FFFD without a word. For a name
// that is a different name, stored as though the device had sent it.
func TestValidTextRefusesWhatDecodingWouldChange(t *testing.T) {
	bs := string(rune(0x5c)) // one backslash
	good := []string{
		`{"op":"rename","name":"laptop"}`,
		`{"name":"` + esc("d83d") + esc("de00") + ` face"}`,                // a pair, escaped
		`{"name":"` + esc("D83D") + esc("DE00") + ` face"}`,                // and in upper case
		`{"name":"` + raw(0xf0, 0x9f, 0x98, 0x80) + ` face"}`,              // the same character, as UTF-8
		`{"name":"` + bs + bs + `ud800 is text, not an escape"}`,           // an escaped backslash, then letters
		`{"name":"` + bs + bs + bs + bs + `ud800"}`,                        // two escaped backslashes, then letters
		`{"name":"a` + bs + `"b` + bs + bs + `"}`,                          // an escaped quote, and a backslash last
		`{"a":"` + esc("d83d") + esc("de00") + `","b":"` + bs + `"` + `"}`, // a pair, then an escaped quote
		`{"name":"` + esc("00e9") + `t` + esc("00E9") + `"}`,               // escapes outside the surrogates
		`{"name":"` + raw(0xef, 0xbf, 0xbd) + ` is a character"}`,          // U+FFFD itself, sent on purpose
		`{"name":"a` + bs, // cut off: the decoder's to refuse
		`"` + bs + `ud8`,  // malformed: the decoder's to refuse
	}
	for _, g := range good {
		if err := ValidText([]byte(g)); err != nil {
			t.Errorf("%q was refused: %v", g, err)
		}
	}

	bad := []string{
		`{"name":"a` + raw(0xff) + `b"}`,                                          // not UTF-8
		`{"name":"a` + raw(0xed, 0xa0, 0x80) + `"}`,                               // a surrogate, encoded as UTF-8
		`{"name":"` + esc("d800") + `.md"}`,                                       // a high half alone
		`{"name":"` + esc("dc00") + `.md"}`,                                       // a low half alone
		`{"name":"x` + esc("DE00") + `"}`,                                         // a low half, in upper case
		`{"name":"` + esc("d800") + esc("0041") + `"}`,                            // a high half, then something else
		`{"name":"` + esc("d800") + esc("d800") + `"}`,                            // two high halves
		`{"name":"x` + esc("d83d") + `"}`,                                         // a high half at the end of the string
		`{"name":"` + bs + bs + esc("d800") + `"}`,                                // an escaped backslash, then a real escape
		`{"ok":"` + esc("d83d") + esc("de00") + `","name":"` + esc("de00") + `"}`, // fine, then not
	}
	for _, b := range bad {
		if err := ValidText([]byte(b)); !errors.Is(err, ErrNotText) {
			t.Errorf("%q was answered %v, want ErrNotText", b, err)
		}
	}

	// And each bad one really is changed by decoding, which is the whole reason
	// for refusing it: a check against a harmless shape would refuse nothing
	// anybody sends and pass all the same.
	for _, b := range bad {
		var m map[string]string
		if err := json.Unmarshal([]byte(b), &m); err != nil {
			t.Errorf("%q is refused by the decoder itself, so it shows nothing here: %v", b, err)
			continue
		}
		if !strings.ContainsRune(m["name"], utf8.RuneError) {
			t.Errorf("%q decodes to %q, which is no repair", b, m["name"])
		}
	}
}
