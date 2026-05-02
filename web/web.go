// Package web exposes the embedded SPA build output as a virtual filesystem.
// Keeping the embed declaration in this directory means go:embed can reach
// the sibling `dist` folder; consumers in `internal/api` import this package.
package web

import "embed"

//go:embed all:dist
var distFS embed.FS

// FS returns the embedded filesystem rooted at the project's web/ directory
// (so callers reference paths like "dist/index.html").
func FS() embed.FS { return distFS }
