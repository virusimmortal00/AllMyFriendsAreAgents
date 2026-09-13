#!/bin/sh
/opt/amfaa/amfaa "$@"
result=$?
if [ "$result" -ne 0 ] || [ ! -t 0 ]; then exit "$result"; fi
printf '\nSandbox shell: amfaa status | amfaa stop | amfaa start\nKeep this sandbox terminal open to retain the container.\nType exit to delete this disposable container and all its data.\n\n'
export PS1='sandbox> '
exec /bin/sh -i
