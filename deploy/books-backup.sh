#!/bin/sh
# Section 5: copies each user's book files to R2, run by unblent-books-backup.timer.
# A book's files are written once, at import, so a run sends only files written
# since the last successful run, each once, and asks R2 nothing when there are
# none: every request to R2 is billed, and comparing the whole tree on each run
# would be over a million requests a day. A run that fails leaves the mark where it
# was, so the next run sends what this one missed, however long R2 was away.
set -eu
state="${STATE_DIRECTORY:?run from unblent-books-backup.service}"
data=/opt/unblent/data
mark="$state/last-run"

# Set before looking, so a file written while this run copies is newer than the
# next mark too and goes in the next run.
touch "$state/this-run"
cd "$data"
if [ -e "$mark" ]; then
    find . -path './*/books/*' -type f -newer "$mark" | sed 's|^\./||' > "$state/files"
    if [ -s "$state/files" ]; then
        rclone copy . r2:unblent-data --files-from-raw "$state/files" --no-check-dest \
            --transfers 4 --s3-no-check-bucket
    fi
else
    # No mark yet: compare every file once against the bucket and send what is missing.
    rclone copy . r2:unblent-data --include "/*/books/**" --transfers 4 --s3-no-check-bucket
fi
mv "$state/this-run" "$mark"
