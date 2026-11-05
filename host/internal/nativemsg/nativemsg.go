// Package nativemsg implementa o enquadramento do Chrome Native Messaging:
// cada mensagem é um JSON precedido por 4 bytes com o tamanho (little-endian).
package nativemsg

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Limite do Chrome para mensagens host → extensão.
const maxToExtension = 1 << 20

// Limite que aceitamos da extensão (o Chrome permite até 64 MiB).
const maxFromExtension = 64 << 20

func Read(r io.Reader) ([]byte, error) {
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		return nil, err
	}
	if size > maxFromExtension {
		return nil, fmt.Errorf("mensagem grande demais: %d bytes", size)
	}
	buf := make([]byte, size)
	_, err := io.ReadFull(r, buf)
	return buf, err
}

// Writer serializa escritas concorrentes no stdout do host.
type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

func (w *Writer) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(b) > maxToExtension {
		return fmt.Errorf("mensagem para a extensão excede 1 MiB (%d bytes)", len(b))
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := binary.Write(w.w, binary.LittleEndian, uint32(len(b))); err != nil {
		return err
	}
	_, err = w.w.Write(b)
	return err
}
