//go:build windows

package headless

import (
	"fmt"
	"os/exec"
	"syscall"
)

func applyDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

func killProcessTree(pid int) error {
	if pid <= 0 {
		return nil
	}
	out, err := exec.Command("taskkill", "/PID", fmt.Sprintf("%d", pid), "/T", "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, string(out))
	}
	return nil
}
