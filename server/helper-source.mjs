// Read-only source projection. Production's delivery/time index is reused; never mutate Hermes DB.
export const HELPER_SOURCE_LIMIT = 512
// Enumerate distinct delivery values by indexed successor seeks, not DISTINCT's archive scan.
// Delivery state is not execution state: unknown/new delivery values must remain visible.
export function helperDeliveryStates(db) {
  const values=[]
  let value=db.prepare('SELECT min(delivery_state) AS value FROM async_delegations').get()?.value
  while (value !== null && value !== undefined && values.length<33) {
    values.push(value)
    value=db.prepare('SELECT min(delivery_state) AS value FROM async_delegations WHERE delivery_state>?').get(value)?.value
  }
  return values.length>32 ? null : values
}
export function helperDelegationQuery(db, ids, nowSeconds) {
  const cols = new Set(db.prepare('PRAGMA table_info(async_delegations)').all().map(r => r.name))
  const origins = ['origin_session_id','parent_session_id','origin_ui_session_id'].filter(k => cols.has(k))
  if (!origins.length) return null
  const origin = `COALESCE(${origins.map(k => `NULLIF(${k},'')`).join(',')},'')`
  const select = `SELECT delegation_id,${origin} AS session_id,state,dispatched_at,completed_at,task_json FROM async_delegations`
  const targets = `${origin} IN (${ids.map(() => '?').join(',')})`
  const values = helperDeliveryStates(db)
  if (!values) return null
  const delivery = `(delivery_state IS NULL ${values.length ? `OR delivery_state IN (${values.map(() => '?').join(',')})` : ''})`
  const sql = `${select} WHERE ${delivery} AND completed_at IS NULL AND ${targets}
    UNION ALL ${select} WHERE ${delivery} AND completed_at>=? AND ${targets}
    LIMIT ${HELPER_SOURCE_LIMIT+1}`
  return { sql, params: [...values, ...ids, ...values, nowSeconds-6*3600, ...ids] }
}
export function assignedHelperCount(row) {
  try {
    const task = JSON.parse(row.task_json || '{}')
    const goals = Array.isArray(task.goals) ? task.goals : []
    if (Object.hasOwn(task, 'task_indexes')) {
      // Invalid indexes must not silently inflate to the full shared goals batch.
      const indexes = Array.isArray(task.task_indexes) ? task.task_indexes : []
      return new Set(indexes.filter(i => Number.isInteger(i) && i >= 0 && i < goals.length)).size
    }
    return Math.max(1, goals.length) // legacy ungrouped records
  } catch { return 1 }
}
