package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestExtractArtexCallOpts(t *testing.T) {
	oldURL, oldTok := ArtexURL, ArtexToken
	ArtexURL = "http://env-artex:8080"
	ArtexToken = "env-secret-jwt"
	defer func() {
		ArtexURL, ArtexToken = oldURL, oldTok
	}()

	in := json.RawMessage(`{"tab_id":1,"artex_ingest":true,"artex_url":"http://override:9000","artex_token":"override-jwt","url_pattern":"/api"}`)
	clean, opts := extractArtexCallOpts("read_network", in)
	if !opts.Enabled || opts.URL != "http://override:9000" || opts.Token != "override-jwt" {
		t.Fatalf("opts = %+v", opts)
	}
	s := string(clean)
	if strings.Contains(s, "override-jwt") || strings.Contains(s, "artex_token") || strings.Contains(s, "artex_url") {
		t.Fatalf("clean args leaked artex secrets: %s", s)
	}
	if !strings.Contains(s, `"artex_ingest":true`) {
		t.Fatalf("clean args dropped artex_ingest: %s", s)
	}

	// Em batch, segredos aninhados também são removidos e opts herda fallback do ambiente.
	batchIn := json.RawMessage(`{"tab_id":1,"actions":[{"tool":"http_repeater","args":{"url":"https://a/b","artex_ingest":true,"artex_token":"nested-secret"}}]}`)
	cleanBatch, bOpts := extractArtexCallOpts("batch", batchIn)
	if !bOpts.Enabled || bOpts.URL != "http://env-artex:8080" || bOpts.Token != "nested-secret" {
		t.Fatalf("batch opts = %+v", bOpts)
	}
	if strings.Contains(string(cleanBatch), "nested-secret") || strings.Contains(string(cleanBatch), "artex_token") {
		t.Fatalf("batch args leaked nested secret: %s", cleanBatch)
	}

	// Tool não suportada não habilita ingestão, mas ainda remove eventuais credenciais.
	_, tabOpts := extractArtexCallOpts("tabs_create", json.RawMessage(`{"url":"https://x","artex_ingest":true,"artex_token":"leak"}`))
	if tabOpts.Enabled {
		t.Fatal("tabs_create should not enable artex ingest")
	}
}

func TestSanitizeHeaders(t *testing.T) {
	in := map[string]string{
		":method":      "GET",
		":path":        "/api",
		"Content-Type": "application/json",
		"Bad Header":   "drop-me",
		"Cookie":       "a=1\r\nb=2\x00",
		"X-Multi":      "v1\nv2",
	}
	got := sanitizeHeaders(in)
	if _, ok := got[":method"]; ok {
		t.Fatalf("pseudo-header not removed: %+v", got)
	}
	if _, ok := got["bad header"]; ok {
		t.Fatalf("invalid header not removed: %+v", got)
	}
	if got["content-type"] != "application/json" {
		t.Fatalf("content-type = %q", got["content-type"])
	}
	if got["cookie"] != "a=1; b=2" {
		t.Fatalf("cookie = %q", got["cookie"])
	}
	if got["x-multi"] != "v1, v2" {
		t.Fatalf("x-multi = %q", got["x-multi"])
	}
}

func TestIngestExchangesBatchAndAuth(t *testing.T) {
	var mu sync.Mutex
	var batchSizes []int
	var maxBodySeen int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/traffic/ingest" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer valid-jwt" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var req struct {
			Exchanges []ExternalExchange `json:"exchanges"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(req.Exchanges) > artexMaxIngestBatch {
			http.Error(w, "too many exchanges in one batch", http.StatusBadRequest)
			return
		}
		mu.Lock()
		batchSizes = append(batchSizes, len(req.Exchanges))
		for _, e := range req.Exchanges {
			if len(e.ResponseBody) > maxBodySeen {
				maxBodySeen = len(e.ResponseBody)
			}
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ingested":%d,"failed":0}`, len(req.Exchanges))
	}))
	defer srv.Close()

	// 55 entradas: 1 URL inválida (chrome://) + 54 válidas (incluindo body > 256 KiB).
	exchanges := []ExternalExchange{{Method: "GET", URL: "chrome://settings", Status: 200}}
	for i := 0; i < 54; i++ {
		body := "ok"
		if i == 0 {
			body = strings.Repeat("A", artexMaxIngestBodySize+4096)
		}
		exchanges = append(exchanges, ExternalExchange{
			Method:          "GET",
			URL:             fmt.Sprintf("https://target.local/item/%d", i),
			Status:          200,
			RequestHeaders:  map[string]string{":authority": "target.local", "X-Test": "1"},
			ResponseHeaders: map[string]string{"Content-Type": "text/plain"},
			ResponseBody:    body,
		})
	}

	ingested, failed, err := IngestExchanges(context.Background(), srv.URL, "valid-jwt", false, exchanges)
	if err != nil {
		t.Fatalf("IngestExchanges error: %v", err)
	}
	if ingested != 54 || failed != 1 {
		t.Fatalf("ingested=%d failed=%d, want 54/1", ingested, failed)
	}
	if len(batchSizes) != 2 || batchSizes[0] != 50 || batchSizes[1] != 4 {
		t.Fatalf("batchSizes = %v, want [50 4]", batchSizes)
	}
	if maxBodySeen != artexMaxIngestBodySize {
		t.Fatalf("maxBodySeen = %d, want %d", maxBodySeen, artexMaxIngestBodySize)
	}

	if _, _, err := IngestExchanges(context.Background(), srv.URL, "bad-jwt", false, exchanges[:2]); err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected HTTP 401 error, got %v", err)
	}
}

func TestProcessArtexIngestStripsInternalField(t *testing.T) {
	var received []ExternalExchange
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Exchanges []ExternalExchange `json:"exchanges"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		received = append(received, req.Exchanges...)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ingested":%d,"failed":0}`, len(req.Exchanges))
	}))
	defer srv.Close()

	extRaw := json.RawMessage(`{
		"content": [{"type":"text","text":"=== RESPONSE ===\nHTTP/1.1 200 OK"}],
		"_artex_exchanges": [{
			"method": "GET",
			"url": "http://127.0.0.1:5959/api/profile",
			"status": 200,
			"requestHeaders": {"X-Custom": "abc"},
			"requestBody": "",
			"responseHeaders": {"Content-Type": "application/json"},
			"responseBody": "{\"role\":\"guest\"}"
		}]
	}`)

	// Quando opts.Enabled == false, _artex_exchanges deve ser removido mesmo assim.
	cleanDisabled := processArtexIngest(context.Background(), extRaw, artexCallOpts{Enabled: false})
	if strings.Contains(string(cleanDisabled), "_artex_exchanges") {
		t.Fatalf("_artex_exchanges leaked when disabled: %s", cleanDisabled)
	}
	if len(received) != 0 {
		t.Fatalf("unexpected ingest call when disabled")
	}

	// Quando opts.Enabled == true, envia e anexa resumo sem vazar _artex_exchanges.
	cleanEnabled := processArtexIngest(context.Background(), extRaw, artexCallOpts{
		Enabled: true,
		URL:     srv.URL,
		Token:   "tok",
	})
	if strings.Contains(string(cleanEnabled), "_artex_exchanges") {
		t.Fatalf("_artex_exchanges leaked when enabled: %s", cleanEnabled)
	}
	if !strings.Contains(string(cleanEnabled), "[ARTEX ingest] ✓ 1 troca(s) enviada(s)") {
		t.Fatalf("missing ingest summary: %s", cleanEnabled)
	}
	if len(received) != 1 || received[0].ResponseHeaders["content-type"] != "application/json" {
		t.Fatalf("received = %+v", received)
	}
}
