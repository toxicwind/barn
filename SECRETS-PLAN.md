# Secrets migration plan

## Current state
- ~/.secrets: 264 KEY=value lines (flat file)
- secretsmith: Secret Service CLI at barn/secretsmith/
- bw: Bitwarden CLI installed via mise

## Target
- Bitwarden as primary store
- rosec (forked: toxicwind/rosec) as Secret Service D-Bus bridge
  - Read-only Bitwarden backend today
  - Apps using libsecret can read from Bitwarden
- Migrate ~/.secrets entries into Bitwarden collections
- Drop estate-scripts_ env prefix (already done in READMEs)

## Next steps
1. Install/configure rosec with Bitwarden provider
2. Audit ~/.secrets for what moves vs stays local
3. Script the import (bw create item or rosec import)
4. Update skills (exa, pattern-forge, gatehouse) to prefer rosec/bw over flat file
