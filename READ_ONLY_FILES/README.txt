This is the READ-ONLY shared folder.

Put files here that you want JARVIS to READ but never change — reference docs,
data, spreadsheets, images, anything you want it to work from.

JARVIS sees this folder mounted at /READ_ONLY_FILES. It can list and read files
here (list_dir, read_file, read_document, analyze_image), but it CANNOT modify or
delete anything — the folder is mounted read-only.

For files you want JARVIS to CREATE or CHANGE — and for the finished work it
produces for you — use the read-write folder next door: READ_WRITE_FILES/
(mounted at /READ_WRITE_FILES).

In chat, the /ro command tells JARVIS to reference what's in here — e.g.
"/ro summarize the contract" (or just "/ro" to list the files).

---
JARVIS_Guides/  — shipped self-help guides about JARVIS itself (how to switch
models, set up local models, use Autopilot, maintenance, a glossary of terms).
Ask JARVIS "how do I ..." or use the /guide command and it will read these and
walk you through the steps. Leave this folder in place; add your own files
alongside it.
