#!/usr/bin/env bash
# Print the next batch of work from the Flow work queue as a JSON array —
# empty when nothing is staged. Always valid JSON, so it is safe to pipe into
# a parser.
#
# The next batch is the topmost "Queued for Dev" item in the project's own item
# order, together with every other queued item sharing its Batch number. Items
# with no Batch are a batch of one.
#
#   bash skills/work-project-tasks/next-batch.sh
#
# Override the target with BOARD_OWNER / BOARD_NUMBER.
set -euo pipefail

OWNER=${BOARD_OWNER:-freeflow-im}
NUM=${BOARD_NUMBER:-1}

gh api graphql -F owner="$OWNER" -F number="$NUM" -f query='
query($owner:String!, $number:Int!) {
  organization(login:$owner) { projectV2(number:$number) {
    items(first:100) { nodes {
      id
      status: fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      batch:  fieldValueByName(name:"Batch")  { ... on ProjectV2ItemFieldNumberValue { number } }
      content { ... on Issue { number title url body repository { nameWithOwner } } }
    } } } } }' --jq '
  [ .data.organization.projectV2.items.nodes[]
    | select(.content.number)                      # drafts and PRs are not tasks
    | { itemId: .id, number: .content.number, title: .content.title,
        url: .content.url, repo: .content.repository.nameWithOwner,
        body: .content.body,
        status: (.status.name // null), batch: (.batch.number // null) } ]
  | . as $all
  | ( [ $all[] | select(.status == "Queued for Dev") ] | first ) as $head
  | if   $head == null       then []          # nothing queued
    elif $head.batch == null then [ $head ]
    else [ $all[] | select(.status == "Queued for Dev" and .batch == $head.batch) ]
    end'
