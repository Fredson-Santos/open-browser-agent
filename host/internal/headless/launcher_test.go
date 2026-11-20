package headless

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectChromiumMajorFromSiblingDirs(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "brave.exe")
	if err := os.WriteFile(bin, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}

	// Diretórios não numéricos devem ser ignorados; maior versão vence.
	for _, sub := range []string{"SetupMetrics", "156.0.1.2", "158.1.100.58"} {
		if err := os.Mkdir(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	if got := detectChromiumMajor(bin); got != "158" {
		t.Fatalf("detectChromiumMajor = %q, want %q", got, "158")
	}
}

func TestBuildCleanUserAgentAndOverride(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "brave.exe")
	if err := os.WriteFile(bin, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "158.1.100.58"), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OBA_USER_AGENT", "")
	ua := buildCleanUserAgent(bin)
	if strings.Contains(strings.ToLower(ua), "headless") {
		t.Fatalf("UA should not contain headless: %q", ua)
	}
	if !strings.Contains(ua, "Chrome/158.0.0.0") {
		t.Fatalf("UA missing Chrome/158.0.0.0: %q", ua)
	}

	custom := "Mozilla/5.0 Custom/1.0 HeadlessChrome/158.0.0.0 Safari/537.36"
	t.Setenv("OBA_USER_AGENT", custom)
	if got := buildCleanUserAgent(bin); got != custom {
		t.Fatalf("OBA_USER_AGENT override = %q, want %q", got, custom)
	}
}
