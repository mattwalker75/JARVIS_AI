This is the READ-WRITE shared folder — the two-way exchange between you and JARVIS.

- Drop files here for JARVIS to work on. (Uploads from the web UI land in
  READ_WRITE_FILES/uploads/.)
- JARVIS saves the FINISHED deliverables it makes for you here — files, reports,
  code, generated data — so they appear on your computer automatically.

JARVIS sees this folder mounted at /READ_WRITE_FILES and can read, create, and
change files in it.

Its scratch/build area is a separate INTERNAL workspace (/workspace) — in-progress
build files live there, not here; only finished output is copied here.

For files you want JARVIS to READ but never modify, use the read-only folder next
door: READ_ONLY_FILES/ (mounted at /READ_ONLY_FILES).
