#!/bin/sh
# Install a published self-contained native application bundle. The release
# manifest is the authority for the exact bytes that may be activated.
set -eu

PROGRAM=all-my-friends-are-agents
REPOSITORY=https://github.com/virusimmortal00/AllMyFriendsAreAgents
INSTALL_DIR=${AMFAA_INSTALL_DIR:-"$HOME/.local/share/$PROGRAM"}
VERSION=
MODIFY_PATH=0
LOCAL_FIXTURES=0
DRY_RUN=0
COMMAND=install
MARKER=.amfaa-installer-root.json
RECEIPT=installer-receipt.json

usage() { cat <<'EOF'
All My Friends Are Agents installer

Usage: install-native.sh [install|update|rollback|uninstall] [options]
  --version VERSION       install an immutable application version
  --dir DIRECTORY         installation root (default: ~/.local/share/all-my-friends-are-agents)
  --modify-path           add the installation root to ~/.profile
  --no-modify-path        do not change shell configuration (default)
  --dry-run               preview the operation without downloads or changes
  -h, --help              show this help
EOF
}
die() { printf '%s\n' "install-native: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "requires $1"; }

while [ $# -gt 0 ]; do
  case $1 in
    install|update|rollback|uninstall) COMMAND=$1 ;;
    --version) shift; [ $# -gt 0 ] || die "--version requires a value"; VERSION=$1 ;;
    --dir) shift; [ $# -gt 0 ] || die "--dir requires a value"; INSTALL_DIR=$1 ;;
    --modify-path) MODIFY_PATH=1 ;;
    --no-modify-path|--no-path-modification) MODIFY_PATH=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --allow-local-fixtures) LOCAL_FIXTURES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

case $(uname -s) in Darwin) OS=darwin;; Linux) OS=linux;; *) die "unsupported platform: $(uname -s)";; esac
case $(uname -m) in arm64|aarch64) ARCH=arm64;; x86_64|amd64) ARCH=x64;; *) die "unsupported architecture: $(uname -m)";; esac
TARGET=$OS-$ARCH

preview() {
  case $COMMAND in
    install) action=Install;;
    update) action=Update;;
    rollback) action=Rollback;;
    uninstall) action=Uninstall;;
  esac
  if [ -n "$VERSION" ]; then release="Version $VERSION"; else release="Latest release"; fi
  if [ "$MODIFY_PATH" = 1 ]; then path_change="Add $INSTALL_DIR to ~/.profile"; else path_change="None (use --modify-path to enable)"; fi
  printf '%s\n' \
    "" \
    "All My Friends Are Agents" \
    "Installer preview" \
    "" \
    "  Action:       $action" \
    "  Release:      $release" \
    "  Platform:     $TARGET" \
    "  Destination:  $INSTALL_DIR" \
    "  PATH changes: $path_change" \
    "" \
    "Planned steps:" \
    "  1. Read the release manifest from GitHub" \
    "  2. Download the application bundle, SBOM, and provenance" \
    "  3. Verify file sizes, SHA-256 hashes, provenance, and bundle inventory" \
    "  4. Activate the verified launcher at $INSTALL_DIR/amfaa" \
    "" \
    "Run again without --dry-run to continue." \
    "No downloads or changes were made."
}

if [ "$DRY_RUN" = 1 ]; then
  case $COMMAND in install|update) preview; exit 0;; *) die "--dry-run supports install and update";; esac
fi

assert_safe_root() {
  [ -n "$INSTALL_DIR" ] || die "installation directory is empty"
  case $INSTALL_DIR in /|"$HOME"|"$HOME/.local"|"$HOME/.local/share") die "installation directory is too broad";; esac
  [ ! -L "$INSTALL_DIR" ] || die "installation directory must not be a symbolic link"
  if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then die "installation directory is not a directory"; fi
}
assert_owned_root() {
  assert_safe_root
  [ -f "$INSTALL_DIR/$MARKER" ] || die "installation directory is not owned by this installer"
  python3 - "$INSTALL_DIR/$MARKER" <<'PY' || die "invalid installer ownership marker"
import json,sys
try: value=json.load(open(sys.argv[1]))
except Exception: raise SystemExit(1)
if value != {'schemaVersion':1,'application':'all-my-friends-are-agents'}: raise SystemExit(1)
PY
}
atomic_text() { destination=$1; value=$2; temporary_file="$destination.tmp.$$"; (umask 077; printf '%s\n' "$value" > "$temporary_file"); mv -f "$temporary_file" "$destination"; }
identifier() { printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]+$'; }
verified_inventory() {
  python3 - "$1" <<'PY'
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1])
try: inventory=json.load(open(root/'inventory.json'))
except Exception: raise SystemExit(1)
listed={x['path']:x for x in inventory.get('files',[]) if isinstance(x,dict) and isinstance(x.get('path'),str)}
actual={}
for base,dirs,files in os.walk(root,followlinks=False):
 for name in dirs+files:
  p=pathlib.Path(base,name); rel=p.relative_to(root).as_posix()
  if rel=='inventory.json': continue
  if p.is_symlink(): actual[rel]=hashlib.sha256(('symlink:'+os.readlink(p)).encode()).hexdigest()
  elif p.is_file(): actual[rel]=hashlib.sha256(p.read_bytes()).hexdigest()
if set(listed)!=set(actual) or any(x.get('sha256')!=actual[name] or x.get('type') not in ('file','symlink') for name,x in listed.items()): raise SystemExit(1)
PY
}

if [ "$COMMAND" = rollback ]; then
  need python3; assert_owned_root
  current=$(sed -n '1p' "$INSTALL_DIR/active-version" 2>/dev/null || true)
  previous=$(python3 - "$INSTALL_DIR/previous.json" <<'PY'
import json,sys
try: value=json.load(open(sys.argv[1])); result=value['versionDirectory'] if value.get('schemaVersion') == 1 else ''
except Exception: result=''
print(result)
PY
)
  identifier "$current" && identifier "$previous" || die "invalid rollback metadata"
  [ -f "$INSTALL_DIR/versions/$previous/inventory.json" ] || die "no retained verified version"
  verified_inventory "$INSTALL_DIR/versions/$previous" || die "retained version failed inventory verification"
  atomic_text "$INSTALL_DIR/previous.json" "{\"schemaVersion\":1,\"versionDirectory\":\"$current\"}"
  atomic_text "$INSTALL_DIR/active-version" "$previous"
  printf '%s\n' "Rolled back to $previous."
  exit 0
fi

remove_path_block() {
  rc=$HOME/.profile
  [ -f "$rc" ] || return 0
  python3 - "$rc" "$INSTALL_DIR" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); root=sys.argv[2]
begin=f'# >>> all-my-friends-are-agents:{root} >>>\n'; end=f'# <<< all-my-friends-are-agents:{root} <<<\n'
text=p.read_text(); start=text.find(begin)
if start >= 0:
 finish=text.find(end,start)
 if finish >= 0: p.write_text(text[:start]+text[finish+len(end):])
PY
}
if [ "$COMMAND" = uninstall ]; then
  need python3
  [ -e "$INSTALL_DIR" ] || { printf '%s\n' "No installation found; user state was retained."; exit 0; }
  assert_owned_root
  path_modified=0
  [ ! -f "$INSTALL_DIR/$RECEIPT" ] || path_modified=$(python3 - "$INSTALL_DIR/$RECEIPT" <<'PY'
import json,sys
try: print(1 if json.load(open(sys.argv[1])).get('pathModified') is True else 0)
except Exception: raise SystemExit(1)
PY
)
  [ "$path_modified" != 1 ] || remove_path_block
  # A marker authorizes this root, not arbitrary additions inside it. Remove
  # only retained directories that still prove they were installer artifacts.
  if [ -d "$INSTALL_DIR/versions" ]; then
    for version_root in "$INSTALL_DIR"/versions/*; do
      [ -d "$version_root" ] || continue
      verified_inventory "$version_root" && rm -rf "$version_root"
    done
    rmdir "$INSTALL_DIR/versions" 2>/dev/null || true
  fi
  rm -f "$INSTALL_DIR/amfaa" "$INSTALL_DIR/active-version" "$INSTALL_DIR/previous.json" "$INSTALL_DIR/$RECEIPT"
  if [ ! "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 ! -name "$MARKER" -print -quit 2>/dev/null)" ]; then
    rm -f "$INSTALL_DIR/$MARKER"
    rmdir "$INSTALL_DIR" 2>/dev/null || true
  fi
  printf '%s\n' "Removed installed application; user state and unrelated files were retained."
  exit 0
fi

need python3; need tar; need curl
assert_safe_root
if [ -f "$INSTALL_DIR/$MARKER" ]; then assert_owned_root
elif [ -d "$INSTALL_DIR" ] && [ "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then die "installation directory is not empty and is not owned by this installer"
fi
mkdir -p "$INSTALL_DIR"
if [ -n "$VERSION" ]; then MANIFEST_URL="$REPOSITORY/releases/download/v$VERSION/native-release-manifest.json"; else MANIFEST_URL="$REPOSITORY/releases/latest/download/native-release-manifest.json"; fi
MANIFEST_URL=${AMFAA_MANIFEST_URL:-$MANIFEST_URL}
case $MANIFEST_URL in https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/*|file://*) ;; *) die "manifest URL is not an approved release entrypoint";; esac
[ "$LOCAL_FIXTURES" = 1 ] || case $MANIFEST_URL in file://*) die "local fixtures require --allow-local-fixtures";; esac

# Staging beneath the installation root keeps final moves on one filesystem.
stage="$INSTALL_DIR/.installer-stage-$$"
rm -rf "$stage"; mkdir "$stage"
trap 'rm -rf "$stage"' EXIT HUP INT TERM
fetch() { case $1 in file://*) cp "${1#file://}" "$2";; *) curl --fail --location --proto '=https' --tlsv1.2 -o "$2" "$1";; esac; }
fetch "$MANIFEST_URL" "$stage/manifest.json"
metadata=$(python3 - "$stage/manifest.json" "$TARGET" "$VERSION" "$LOCAL_FIXTURES" <<'PY'
import json,re,sys
m=json.load(open(sys.argv[1])); target,requested,local=sys.argv[2],sys.argv[3],sys.argv[4]=='1'
if set(m)!= {'schemaVersion','application','downstream','targets'} or m.get('schemaVersion') != 1: raise SystemExit('unsupported manifest contract')
a=m.get('application',{}); version=a.get('version','')
if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?',version) or requested and requested != version: raise SystemExit('manifest version mismatch')
entries=[x for x in m.get('targets',[]) if x.get('id')==target]
if len(entries)!=1: raise SystemExit('manifest does not support this platform')
t=entries[0]; prefix=f'all-my-friends-are-agents-v{version}-{target}.tar.gz'; base=f'https://github.com/virusimmortal00/AllMyFriendsAreAgents/releases/download/v{version}/'
for key,suffix in [('artifact',''),('sbom','.spdx.json'),('provenance','.intoto.jsonl')]:
 f=t.get(key,{}); name,url,digest,size=f.get('name',''),f.get('url',''),f.get('sha256',''),f.get('size')
 if name != prefix+suffix or not re.fullmatch('[0-9a-f]{64}',digest) or not isinstance(size,int) or size < 1: raise SystemExit('invalid immutable artifact metadata')
 if url != base+name and not (local and url.startswith('file://')): raise SystemExit('unapproved artifact URL')
 print(key,name,url,size,digest,sep='\t')
PY
) || die "manifest validation failed"
field() { printf '%s\n' "$metadata" | awk -F '\t' -v key="$1" -v number="$2" '$1==key {print $number; exit}'; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }
download_checked() { fetch "$1" "$2"; [ "$(wc -c < "$2" | tr -d ' ')" = "$3" ] || die "size verification failed"; [ "$(sha256 "$2")" = "$4" ] || die "SHA-256 verification failed"; }
artifact_name=$(field artifact 2); artifact_sha=$(field artifact 5)
download_checked "$(field artifact 3)" "$stage/artifact" "$(field artifact 4)" "$artifact_sha"
download_checked "$(field sbom 3)" "$stage/sbom" "$(field sbom 4)" "$(field sbom 5)"
download_checked "$(field provenance 3)" "$stage/provenance" "$(field provenance 4)" "$(field provenance 5)"
python3 - "$stage/provenance" "$artifact_name" "$artifact_sha" <<'PY' || die "provenance is not bound to the artifact"
import base64,json,sys
wanted_name,wanted_hash=sys.argv[2:]
def walk(value,depth=0):
 if depth>8:return []
 out=[]
 if isinstance(value,dict):
  if str(value.get('_type','')).startswith('https://in-toto.io/Statement/'):out.append(value)
  for k,v in value.items():
   if k=='payload' and isinstance(v,str):
    try: out += walk(json.loads(base64.b64decode(v)),depth+1)
    except Exception: pass
   else: out += walk(v,depth+1)
 elif isinstance(value,list):
  for child in value: out += walk(child,depth+1)
 return out
statements=[]
for line in open(sys.argv[1]):
 if line.strip(): statements += walk(json.loads(line))
if not any(s.get('predicateType','').startswith('https://slsa.dev/provenance/') and any(x.get('name')==wanted_name and x.get('digest',{}).get('sha256')==wanted_hash for x in s.get('subject',[])) for s in statements): raise SystemExit(1)
PY
[ "${AMFAA_INTERRUPT_AFTER_DOWNLOAD:-0}" != 1 ] || die "interrupted before application activation"

tar -tzf "$stage/artifact" | awk -v root="$PROGRAM/" 'NF && index($0,root)!=1 {exit 1} /(^|\/)\.\.($|\/)/ || /^\// {exit 1}' || die "archive has an unsafe layout"
mkdir "$stage/expanded"; tar -xzf "$stage/artifact" -C "$stage/expanded"
bundle="$stage/expanded/$PROGRAM"
[ -x "$bundle/amfaa" ] || die "native bundle is missing its launcher"
candidate=$(sed -n '1p' "$bundle/active-version" 2>/dev/null || true); identifier "$candidate" || die "native bundle has invalid active metadata"
candidate_root="$bundle/versions/$candidate"
python3 - "$candidate_root" "$stage/manifest.json" "$TARGET" <<'PY' || die "native bundle inventory or release identity is invalid"
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); manifest=json.load(open(sys.argv[2])); target=sys.argv[3]; inventory=json.load(open(root/'inventory.json')); release=json.load(open(root/'app/release.json'))
if release.get('schemaVersion')!=1 or release.get('target') != target or release.get('application') != {'version':manifest['application']['version'],'commit':manifest['application']['commit']} or release.get('downstream',{}).get('version')!=manifest['downstream'].get('version') or release.get('downstream',{}).get('commit')!=manifest['downstream'].get('commit'): raise SystemExit(1)
listed={x['path']:x for x in inventory.get('files',[])}; actual={}
for base,dirs,files in os.walk(root,followlinks=False):
 for name in dirs+files:
  p=pathlib.Path(base,name); rel=p.relative_to(root).as_posix()
  if rel=='inventory.json': continue
  if p.is_symlink(): actual[rel]=hashlib.sha256(('symlink:'+os.readlink(p)).encode()).hexdigest()
  elif p.is_file(): actual[rel]=hashlib.sha256(p.read_bytes()).hexdigest()
if set(listed)!=set(actual) or any(x.get('sha256')!=actual[name] or x.get('type') not in ('file','symlink') for name,x in listed.items()): raise SystemExit(1)
for name,x in listed.items():
 if x.get('type')=='symlink':
  target=(root/name).parent/os.readlink(root/name)
  if root.resolve() not in [target.resolve(),*target.resolve().parents]: raise SystemExit(1)
PY

mkdir -p "$INSTALL_DIR/versions"
[ -f "$INSTALL_DIR/$MARKER" ] || atomic_text "$INSTALL_DIR/$MARKER" '{"schemaVersion":1,"application":"all-my-friends-are-agents"}'
destination="$INSTALL_DIR/versions/$candidate"
backup="$INSTALL_DIR/.replaced-$candidate-$$"
if [ -e "$destination" ]; then mv "$destination" "$backup"; fi
if ! mv "$candidate_root" "$destination"; then [ ! -e "$backup" ] || mv "$backup" "$destination"; die "could not install verified application version"; fi
[ ! -e "$backup" ] || rm -rf "$backup"
cp "$bundle/amfaa" "$INSTALL_DIR/.amfaa.new.$$"; chmod 755 "$INSTALL_DIR/.amfaa.new.$$"; mv -f "$INSTALL_DIR/.amfaa.new.$$" "$INSTALL_DIR/amfaa"
old=$(sed -n '1p' "$INSTALL_DIR/active-version" 2>/dev/null || true)
if [ -n "$old" ] && [ "$old" != "$candidate" ]; then identifier "$old" || die "existing active metadata is invalid"; atomic_text "$INSTALL_DIR/previous.json" "{\"schemaVersion\":1,\"versionDirectory\":\"$old\"}"; fi
atomic_text "$INSTALL_DIR/active-version" "$candidate"
path_modified=false
if [ -f "$INSTALL_DIR/$RECEIPT" ]; then path_modified=$(python3 - "$INSTALL_DIR/$RECEIPT" <<'PY'
import json,sys
try: print('true' if json.load(open(sys.argv[1])).get('pathModified') is True else 'false')
except Exception: print('false')
PY
); fi
if [ "$MODIFY_PATH" = 1 ]; then
  rc=$HOME/.profile; begin="# >>> all-my-friends-are-agents:$INSTALL_DIR >>>"; end="# <<< all-my-friends-are-agents:$INSTALL_DIR <<<"
  touch "$rc"
  grep -F "$begin" "$rc" >/dev/null 2>&1 || python3 - "$rc" "$INSTALL_DIR" <<'PY'
import pathlib,shlex,sys
pathlib.Path(sys.argv[1]).open('a').write(f'\n# >>> all-my-friends-are-agents:{sys.argv[2]} >>>\nexport PATH={shlex.quote(sys.argv[2])}:"$PATH"\n# <<< all-my-friends-are-agents:{sys.argv[2]} <<<\n')
PY
  path_modified=true
fi
version=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["application"]["version"])' "$stage/manifest.json")
commit=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["application"]["commit"])' "$stage/manifest.json")
atomic_text "$INSTALL_DIR/$RECEIPT" "{\"schemaVersion\":1,\"version\":\"$version\",\"commit\":\"$commit\",\"target\":\"$TARGET\",\"artifactSha256\":\"$artifact_sha\",\"pathModified\":$path_modified}"
printf '%s\n' "Installed verified $TARGET application version $version in $INSTALL_DIR."
