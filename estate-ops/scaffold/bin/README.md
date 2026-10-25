# bin/ — <PEN_NAME> owned entrypoints

Each executable here may be symlinked into `~/.local/bin` (the ONE bin
surface). After adding one, regenerate the manifest:

```bash
cd /home/toxic/pens/barn/estate-ops/bin && python3 manifest-gen.py
cd /home/toxic/pens/barn/estate-ops && bash bin-verify.sh
```

A broken symlink is a FAIL, never a WARN.
