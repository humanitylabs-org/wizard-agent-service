---
name: defleur-video
description: DeFleur Video (acceptance stand-in) makes short-form video from clips in the owner's Files.
---

# DeFleur Video

1. Call `create_short` with `source` = the clip's path relative to the owner's Files root, plus a one-line `brief` if the owner gave one.
2. Tell the owner the job id and where the short will be saved. Use `job_status` if they ask how it is going.

Never edit video yourself with other tools; this app owns the workflow.
