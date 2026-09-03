package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const canonicalHeader = `// SPDX-FileCopyrightText: Copyright (c) 2026 Orange
// SPDX-License-Identifier: MPL-2.0
//
`

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var modified []string

	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Skip hidden directories like .git
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}

		fixed, err := fixFile(path)
		if err != nil {
			return fmt.Errorf("processing %s: %w", path, err)
		}
		if fixed {
			modified = append(modified, path)
		}
		return nil
	})
	if err != nil {
		return err
	}

	fmt.Println("Modified files:")
	for _, f := range modified {
		fmt.Println("  -", f)
	}
	fmt.Printf("\nTotal: %d file(s) modified\n", len(modified))
	return nil
}

func fixFile(path string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}

	lines := splitLines(string(data))
	if len(lines) == 0 {
		return false, nil
	}

	// Check first 50 lines for multiple SPDX-FileCopyrightText occurrences
	spdxCount := 0
	checkLimit := min(len(lines), 50)
	for i := 0; i < checkLimit; i++ {
		if strings.Contains(lines[i], "SPDX-FileCopyrightText") {
			spdxCount++
		}
	}

	if spdxCount <= 1 {
		return false, nil // No piled headers
	}

	// Find the end of the header region (first non-empty, non-comment line within first 50 lines)
	headerEnd := 0
	for i := 0; i < min(len(lines), 50); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" {
			headerEnd = i + 1
			continue
		}
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || strings.HasPrefix(trimmed, "*") {
			headerEnd = i + 1
			continue
		}
		// First non-comment line ends the header
		break
	}

	// Build new content: canonical header + rest of file
	var out bytes.Buffer
	out.WriteString(canonicalHeader)
	if headerEnd < len(lines) {
		// Preserve original line endings for the rest
		rest := strings.Join(lines[headerEnd:], "\n")
		if !strings.HasSuffix(rest, "\n") && len(lines[headerEnd:]) > 0 {
			rest += "\n"
		}
		out.WriteString(rest)
	}

	if err := os.WriteFile(path, out.Bytes(), 0644); err != nil {
		return false, err
	}
	return true, nil
}

func splitLines(s string) []string {
	var lines []string
	scanner := bufio.NewScanner(strings.NewReader(s))
	scanner.Split(bufio.ScanLines)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
