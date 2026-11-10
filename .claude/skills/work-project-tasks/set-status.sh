#!/usr/bin/env bash
# Set the Status of one or more project items.
#
#   bash skills/work-project-tasks/set-status.sh "In Progress" PVTI_xxx PVTI_yyy
#   bash skills/work-project-tasks/set-status.sh Done PVTI_xxx
#
# Ids are looked up by name rather than hardcoded, so this keeps working if the
# project is rebuilt or the Status options are renumbered.
set -euo pipefail

OWNER=${BOARD_OWNER:-freeflow-im}
NUM=${BOARD_NUMBER:-1}

if [ $# -lt 2 ]; then
  echo "usage: set-status.sh <status> <itemId> [<itemId> ...]" >&2
  echo "       status is one of: Todo | Queued for Dev | In Progress | Done" >&2
  exit 2
fi

STATUS=$1; shift

META=$(gh api graphql -F owner="$OWNER" -F number="$NUM" -f query='
query($owner:String!, $number:Int!) {
  organization(login:$owner) { projectV2(number:$number) {
    id field(name:"Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }' \
--jq '.data.organization.projectV2
      | [["project", .id], ["field", .field.id]] + [.field.options[] | ["option:" + .name, .id]]
      | .[] | @tsv')

PROJECT=$(awk -F'\t' '$1=="project"{print $2}' <<<"$META")
FIELD=$(awk -F'\t'   '$1=="field"{print $2}'   <<<"$META")
OPTION=$(awk -F'\t' -v k="option:$STATUS" '$1==k{print $2}' <<<"$META")

if [ -z "$OPTION" ]; then
  echo "unknown status \"$STATUS\". Available:" >&2
  awk -F'\t' '$1 ~ /^option:/ { sub(/^option:/, "", $1); print "  " $1 }' <<<"$META" >&2
  exit 1
fi

for ITEM in "$@"; do
  gh api graphql -f p="$PROJECT" -f i="$ITEM" -f f="$FIELD" -f o="$OPTION" -f query='
    mutation($p:ID!, $i:ID!, $f:ID!, $o:String!) {
      updateProjectV2ItemFieldValue(input:{
        projectId:$p, itemId:$i, fieldId:$f, value:{ singleSelectOptionId:$o }
      }) { clientMutationId } }' > /dev/null
  echo "$ITEM -> $STATUS"
done
