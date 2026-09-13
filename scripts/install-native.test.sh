#!/bin/sh
# Offline acceptance coverage for the POSIX native application installer.
set -eu
root=$(mktemp -d "${TMPDIR:-/tmp}/amfaa-installer-test.XXXXXX")
trap 'rm -rf "$root"' EXIT HUP INT TERM
installer=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/scripts/install-native.sh
case $(uname -s) in Darwin) os=darwin;; Linux) os=linux;; *) exit 0;; esac
case $(uname -m) in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) exit 0;; esac
target=$os-$arch
file_mode() {
  case $os in darwin) stat -f '%Lp' "$1";; linux) stat -c '%a' "$1";; esac
}
test_home=$root/home
command_bin=$root/command-bin
mkdir -p "$test_home"
case "$os:${SHELL:-}" in
  darwin:*/zsh) profile=$test_home/.zprofile;;
  darwin:*/bash) profile=$test_home/.bash_profile;;
  linux:*/zsh) profile=$test_home/.zshrc;;
  linux:*/bash) profile=$test_home/.bashrc;;
  *) profile=$test_home/.profile;;
esac

preview_root=$root/preview-install
preview=$(HOME="$test_home" AMFAA_BIN_DIR="$command_bin" AMFAA_MANIFEST_URL=https://invalid.example/manifest.json "$installer" --dry-run --version 1.2.3 --dir "$preview_root")
[ ! -e "$preview_root" ]
printf '%s\n' "$preview" | grep -F "Installer preview" >/dev/null
printf '%s\n' "$preview" | grep -F "Release:      Version 1.2.3" >/dev/null
printf '%s\n' "$preview" | grep -F "Platform:     $target" >/dev/null
printf '%s\n' "$preview" | grep -F "Destination:  $preview_root" >/dev/null
printf '%s\n' "$preview" | grep -F "Activate the verified launcher at $command_bin/amfaa" >/dev/null
printf '%s\n' "$preview" | grep -F "No downloads or changes were made." >/dev/null
help=$($installer --help)
printf '%s\n' "$help" | grep -F -- "--dry-run" >/dev/null
if printf '%s\n' "$help" | grep -F "Staging beneath" >/dev/null; then exit 1; fi

make_release() {
  version=$1; commit=$2; version_dir=$version-$(printf '%s' "$commit" | cut -c1-12)
  bundle=$root/stage-$version/all-my-friends-are-agents
  app=$bundle/versions/$version_dir/app
  mkdir -p "$app/runtime/node/bin" "$app/runtime/opencode/bin"
  printf '#!/bin/sh\nexit 0\n' > "$app/runtime/node/bin/node"; chmod +x "$app/runtime/node/bin/node"
  printf '#!/bin/sh\necho 1.18.25-amfaa.2\n' > "$app/runtime/opencode/bin/opencode"; chmod +x "$app/runtime/opencode/bin/opencode"
  printf '#!/bin/sh\nexit 0\n' > "$app/native-cli.mjs"
  python3 - "$app/release.json" "$target" "$version" "$commit" <<'PY'
import json,sys
path,target,version,commit=sys.argv[1:]
value={'schemaVersion':1,'target':target,'application':{'version':version,'commit':commit},'node':{'version':'24.5.0'},'downstream':{'version':'1.18.25-amfaa.2','commit':'6883ca5bd35a5494fb2759018373308911c79e01','artifactSha256':'b'*64}}
open(path,'w').write(json.dumps(value)+'\n')
PY
  python3 - "$bundle/versions/$version_dir" <<'PY'
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); files=[]
for base,dirs,names in os.walk(root):
 for name in dirs+names:
  p=pathlib.Path(base,name); rel=p.relative_to(root).as_posix()
  if p.is_symlink(): files.append({'path':rel,'type':'symlink','target':os.readlink(p),'sha256':hashlib.sha256(('symlink:'+os.readlink(p)).encode()).hexdigest()})
  elif p.is_file(): files.append({'path':rel,'type':'file','sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
open(root/'inventory.json','w').write(json.dumps({'schemaVersion':1,'files':files})+'\n')
PY
  printf '%s\n' "$version_dir" > "$bundle/active-version"
  printf '#!/bin/sh\nset -eu\nroot=${0%%/*}; IFS= read -r version < "$root/active-version"\nexec "$root/versions/$version/app/runtime/node/bin/node" "$root/versions/$version/app/native-cli.mjs" "$@"\n' > "$bundle/amfaa"; chmod +x "$bundle/amfaa"
  archive=$root/$version.tar.gz; tar -czf "$archive" -C "$root/stage-$version" all-my-friends-are-agents
  printf '{"spdxVersion":"SPDX-2.3"}\n' > "$root/$version.sbom"
  digest=$( { shasum -a 256 "$archive" 2>/dev/null || sha256sum "$archive"; } | awk '{print $1}')
  printf '{"_type":"https://in-toto.io/Statement/v1","subject":[{"name":"all-my-friends-are-agents-v%s-%s.tar.gz","digest":{"sha256":"%s"}}],"predicateType":"https://slsa.dev/provenance/v1","predicate":{}}\n' "$version" "$target" "$digest" > "$root/$version.provenance"
  python3 - "$root" "$target" "$version" "$commit" <<'PY'
import hashlib,json,sys
root,target,version,commit=sys.argv[1:]
def entry(name,path):
 data=open(path,'rb').read(); return {'name':name,'url':'file://'+path,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()}
name=f'all-my-friends-are-agents-v{version}-{target}.tar.gz'
manifest={'schemaVersion':1,'application':{'version':version,'commit':commit,'repository':'https://github.com/virusimmortal00/AllMyFriendsAreAgents.git'},'downstream':{'version':'1.18.25-amfaa.2','commit':'6883ca5bd35a5494fb2759018373308911c79e01','repository':'https://github.com/anomalyco/opencode.git','sdkVersion':'1.18.25','pluginVersion':'1.18.25'},'targets':[{'id':target,'artifact':entry(name,f'{root}/{version}.tar.gz'),'sbom':entry(name+'.spdx.json',f'{root}/{version}.sbom'),'provenance':entry(name+'.intoto.jsonl',f'{root}/{version}.provenance')}]}
open(f'{root}/{version}.json','w').write(json.dumps(manifest))
PY
}
run() { requested=$1; shift; HOME="$test_home" AMFAA_BIN_DIR="$command_bin" AMFAA_MANIFEST_URL="file://$root/$requested.json" "$installer" --allow-local-fixtures --dir "$root/install" "$@"; }

make_release 1.2.3 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
if AMFAA_INTERRUPT_AFTER_DOWNLOAD=1 run 1.2.3; then exit 1; fi
unset AMFAA_INTERRUPT_AFTER_DOWNLOAD
[ ! -e "$root/install/active-version" ]
run 1.2.3
[ -x "$root/install/amfaa" ]
[ -x "$command_bin/amfaa" ] && [ ! -L "$command_bin/amfaa" ]
grep -F "# AMFAA installer-managed launcher" "$command_bin/amfaa" >/dev/null
"$command_bin/amfaa"
[ "$(cat "$root/install/active-version")" = 1.2.3-aaaaaaaaaaaa ]
[ -f "$root/install/versions/1.2.3-aaaaaaaaaaaa/app/release.json" ]
run 1.2.3 update
[ "$(find "$root/install/versions" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 1 ]

make_release 1.2.4 cccccccccccccccccccccccccccccccccccccccc
run 1.2.4 update
[ "$(cat "$root/install/active-version")" = 1.2.4-cccccccccccc ]
run 1.2.4 rollback
[ "$(cat "$root/install/active-version")" = 1.2.3-aaaaaaaaaaaa ]
run 1.2.4 rollback
[ "$(cat "$root/install/active-version")" = 1.2.4-cccccccccccc ]

python3 - "$root/1.2.3.json" <<'PY'
import json,sys
p=sys.argv[1]; value=json.load(open(p)); value['targets'][0]['artifact']['sha256']='0'*64; open(p,'w').write(json.dumps(value))
PY
if AMFAA_MANIFEST_URL="file://$root/1.2.3.json" "$installer" --allow-local-fixtures --dir "$root/bad-hash"; then exit 1; fi
make_release 1.2.5 dddddddddddddddddddddddddddddddddddddddd
printf '{"unbound":true}\n' > "$root/1.2.5.provenance"
python3 - "$root/1.2.5.json" "$root/1.2.5.provenance" <<'PY'
import hashlib,json,sys
p,proof=sys.argv[1:]; value=json.load(open(p)); data=open(proof,'rb').read(); value['targets'][0]['provenance'].update(size=len(data),sha256=hashlib.sha256(data).hexdigest()); open(p,'w').write(json.dumps(value))
PY
if AMFAA_MANIFEST_URL="file://$root/1.2.5.json" "$installer" --allow-local-fixtures --dir "$root/bad-proof"; then exit 1; fi

mkdir "$root/unowned"; printf keep > "$root/unowned/personal"
if "$installer" uninstall --dir "$root/unowned"; then exit 1; fi
[ -f "$root/unowned/personal" ]
touch "$profile"; chmod 640 "$profile"
run 1.2.4
run 1.2.4
[ "$(file_mode "$profile")" = 640 ]
[ -z "$(find "$(dirname "$profile")" -maxdepth 1 -name ".$(basename "$profile").amfaa-*" -print -quit)" ]
[ "$(grep -Fc '# >>> AMFAA installer >>>' "$profile")" = 1 ]
grep -F "export PATH=$command_bin:\"\$PATH\"" "$profile" >/dev/null
printf '\n# >>> all-my-friends-are-agents:%s >>>\nexport PATH=%s:"$PATH"\n# <<< all-my-friends-are-agents:%s <<<\n' "$root/install" "$root/install" "$root/install" >> "$test_home/.profile"
run 1.2.4 update
[ "$(grep -Fc '# >>> all-my-friends-are-agents:' "$test_home/.profile" || true)" = 0 ]
PATH="$command_bin:$PATH" run 1.2.4 update
[ "$(grep -Fc '# >>> AMFAA installer >>>' "$profile")" = 1 ]
printf keep > "$root/install/personal"
mkdir "$root/install/versions/foreign"; printf keep > "$root/install/versions/foreign/personal"
run 1.2.4 uninstall
[ "$(file_mode "$profile")" = 640 ]
[ -z "$(find "$(dirname "$profile")" -maxdepth 1 -name ".$(basename "$profile").amfaa-*" -print -quit)" ]
[ -f "$root/install/personal" ]
[ -f "$root/install/versions/foreign/personal" ]
[ ! -e "$command_bin/amfaa" ]
[ "$(grep -Fc '# >>> AMFAA installer >>>' "$profile" || true)" = 0 ]

no_path_home=$root/no-path-home; no_path_bin=$root/no-path-bin; mkdir "$no_path_home"
no_path_output=$(HOME="$no_path_home" AMFAA_BIN_DIR="$no_path_bin" AMFAA_MANIFEST_URL="file://$root/1.2.4.json" "$installer" --allow-local-fixtures --no-modify-path --dir "$root/no-path-install")
[ -x "$no_path_bin/amfaa" ]
[ -z "$(find "$no_path_home" -mindepth 1 -maxdepth 1 -type f -print -quit)" ]
printf '%s\n' "$no_path_output" | grep -F "Run: $no_path_bin/amfaa" >/dev/null
printf '%s\n' "$no_path_output" | grep -F "PATH was not changed (--no-modify-path)." >/dev/null
HOME="$no_path_home" AMFAA_BIN_DIR="$no_path_bin" "$installer" uninstall --dir "$root/no-path-install"

conflict_bin=$root/conflict-bin; mkdir "$conflict_bin"; printf keep > "$conflict_bin/amfaa"
if HOME="$test_home" AMFAA_BIN_DIR="$conflict_bin" AMFAA_MANIFEST_URL="file://$root/1.2.4.json" "$installer" --allow-local-fixtures --no-modify-path --dir "$root/conflict-install"; then exit 1; fi
[ "$(cat "$conflict_bin/amfaa")" = keep ]
[ ! -e "$root/conflict-install" ]

writable_bin=$root/writable-bin; mkdir "$writable_bin"; chmod 777 "$writable_bin"
if HOME="$test_home" AMFAA_BIN_DIR="$writable_bin" AMFAA_MANIFEST_URL="file://$root/1.2.4.json" "$installer" --allow-local-fixtures --no-modify-path --dir "$root/writable-install"; then exit 1; fi
[ ! -e "$writable_bin/amfaa" ]
[ -z "$(find "$writable_bin" -mindepth 1 -maxdepth 1 -name '.amfaa-*' -print -quit)" ]
[ ! -e "$root/writable-install" ]

fake_bin=$root/fake-bin; mkdir "$fake_bin"; printf '#!/bin/sh\necho FreeBSD\n' > "$fake_bin/uname"; chmod +x "$fake_bin/uname"
if PATH="$fake_bin:$PATH" "$installer" --dir "$root/unsupported"; then exit 1; fi
printf '%s\n' "POSIX native installer fixtures passed"
