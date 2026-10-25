# Nostr skins fixture evidence

Synthetic `npm run fixture` run, using its isolated temporary Files/state and offline Store. No real owner files, identity, relays or uploads were used. `ORIGIN` below is the loopback origin printed by the fixture (the observed run used port 35289).

Commands actually exercised with `curl --silent --show-error --max-time 10`; the excerpts below retain the observed bodies/statuses. A GET readback followed every successful write.

```sh
curl "$ORIGIN/wizard/v1/skins"
# HTTP 200
# {"active":"My skin","skins":[{"id":"My skin","name":"My skin","summary":"","base":"nebula","bytes":770,"empty":true,"has_script":false,"forked_from":null,"published":null}]}

curl -X POST "$ORIGIN/wizard/v1/skins" -H 'Content-Type: application/json' \
  --data '{"name":"Curl check","css":"body { color: coral; }"}'
# HTTP 200
# {"id":"Curl check"}

curl "$ORIGIN/wizard/v1/skins"
# HTTP 200
# {"active":"My skin","skins":[{"id":"Curl check","name":"Curl check","summary":"","base":"nebula","bytes":22,"empty":false,"has_script":false,"forked_from":null,"published":null},{"id":"My skin","name":"My skin","summary":"","base":"nebula","bytes":770,"empty":true,"has_script":false,"forked_from":null,"published":null}]}

curl -X PUT "$ORIGIN/wizard/v1/skins/active" -H 'Content-Type: application/json' \
  --data '{"id":"Curl check"}'
# HTTP 200; active: "Curl check" in the updated listing

curl "$ORIGIN/wizard/v1/my-skin"
# HTTP 200
# body { color: coral; }

curl -X POST "$ORIGIN/wizard/v1/skins" -H 'Content-Type: application/json' \
  --data '{"name":"Curl check","css":"a{}"}'
# HTTP 200
# {"id":"Curl check 2"}

curl "$ORIGIN/wizard/v1/skins/store?refresh=1"
# HTTP 200
# {"items":[],"featured":[],"fetched_at":1792781151,"relays":[]}

curl -X POST "$ORIGIN/wizard/v1/skins" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' --data '{"name":"Forbidden"}'
# HTTP 403
# {"error":"cross_origin_request"}

curl -X POST "$ORIGIN/wizard/v1/skins/Curl%20check/publish" \
  -H 'Content-Type: application/json' --data '{"event":{}}'
# HTTP 400
# {"error":"invalid_skin_event"}

curl -X PUT "$ORIGIN/wizard/v1/skins/active" -H 'Content-Type: application/json' \
  --data '{"id":null}'
# HTTP 200; active: null in the updated listing

curl "$ORIGIN/wizard/v1/my-skin"
# HTTP 200, empty body

curl "$ORIGIN/wizard/v1/my-skin/script"
# HTTP 404
# {"error":"not_found"}

curl "$ORIGIN/wizard/v1/skins"
# HTTP 200
# {"active":null,"skins":[{"id":"Curl check","name":"Curl check","summary":"","base":"nebula","bytes":22,"empty":false,"has_script":false,"forked_from":null,"published":null},{"id":"Curl check 2","name":"Curl check","summary":"","base":"nebula","bytes":3,"empty":false,"has_script":false,"forked_from":null,"published":null},{"id":"My skin","name":"My skin","summary":"","base":"nebula","bytes":770,"empty":true,"has_script":false,"forked_from":null,"published":null}]}
```

All assertions passed; fixture processes were stopped and their temporary roots removed. Pack, signed publish, Store add/report/blob, and the curator CLI are exercised against the in-process fake relay/Blossom in `tests/skins.test.ts`, not against the offline manual fixture.
