import { useCallback, useEffect, useMemo, useState } from 'react'
import { LuLock, LuPlus, LuPencil, LuTrash2, LuShieldCheck, LuCheck } from 'react-icons/lu'
import Layout from '../components/Layout'
import { useToast, useDialog } from '../components/ui'
import { api } from '../db/api'
import { onChanged } from '../db/store'
import { useT } from '../lib/i18n'
import { PERMISSION_GROUPS, OWNER_ROLE_ID } from '../lib/permissions'

// ── Роли и права ──
// Слева роли, справа права выбранной роли по группам. Владелец — особая роль:
// у него всегда всё, и менять это нельзя, иначе он мог бы запереть сам себя.
// Системную роль кассира нельзя удалить и переименовать, но права в ней
// владелец меняет как хочет. Свои роли — целиком его.

const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k))

export default function Roles() {
  const t = useT()
  const toast = useToast()
  const dialog = useDialog()
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [selId, setSelId] = useState(OWNER_ROLE_ID)
  const [draft, setDraft] = useState([]) // права выбранной роли, пока не сохранены
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const list = await api.get('/roles')
      setRoles(list)
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setLoading(false)
    }
  }, [toast])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => onChanged((keys) => keys.includes('roles') && load()), [load])

  const sel = roles.find((r) => r.id === selId) || roles[0] || null
  // Выбрали другую роль — черновик берётся из неё
  useEffect(() => {
    setDraft(sel ? sel.permissions : [])
  }, [sel?.id, sel?.permissions]) // eslint-disable-line react-hooks/exhaustive-deps

  const owner = sel?.id === OWNER_ROLE_ID
  const dirty = !!sel && !owner && !sameSet(draft, sel.permissions)
  const has = (key) => (owner ? true : draft.includes(key))
  const toggle = (key) => {
    if (owner) return
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]))
  }
  const toggleGroup = (g) => {
    if (owner) return
    const keys = g.items.map(([k]) => k)
    const all = keys.every((k) => draft.includes(k))
    setDraft((d) => (all ? d.filter((k) => !keys.includes(k)) : [...new Set([...d, ...keys])]))
  }

  async function save() {
    if (!sel || !dirty || saving) return
    setSaving(true)
    try {
      const r = await api.patch(`/roles/${sel.id}`, { permissions: draft })
      setRoles((ls) => ls.map((x) => (x.id === r.id ? r : x)))
      toast(t('Права сохранены'))
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setSaving(false)
    }
  }

  async function create() {
    const r = await dialog.prompt({
      title: t('Новая роль'),
      fields: [
        { name: 'name', label: t('Название роли'), placeholder: t('Напр. Старший кассир') },
        { name: 'description', label: t('Описание (необязательно)') },
      ],
      confirmText: t('Создать'),
    })
    if (!r || !r.name.trim()) return
    try {
      const role = await api.post('/roles', { name: r.name.trim(), description: (r.description || '').trim(), permissions: [] })
      setRoles((ls) => [...ls, role])
      setSelId(role.id)
      toast(t('Роль создана. Отметьте права и нажмите «Сохранить права»'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function rename() {
    if (!sel || owner) return
    const r = await dialog.prompt({
      title: t('Переименовать роль'),
      fields: [
        ...(sel.system ? [] : [{ name: 'name', label: t('Название роли'), defaultValue: sel.name }]),
        { name: 'description', label: t('Описание (необязательно)'), defaultValue: sel.description || '' },
      ],
      confirmText: t('Сохранить'),
    })
    if (!r) return
    const body = { description: (r.description || '').trim() }
    if (!sel.system && r.name && r.name.trim()) body.name = r.name.trim()
    try {
      const role = await api.patch(`/roles/${sel.id}`, body)
      setRoles((ls) => ls.map((x) => (x.id === role.id ? role : x)))
      toast(t('Роль изменена'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function remove() {
    if (!sel || owner || sel.system) return
    const ok = await dialog.confirm({
      title: `${t('Удалить роль')} «${sel.name}»?`,
      message: sel.people > 0
        ? `${t('На этой роли')} ${sel.people} ${t('чел.')} ${t('Сначала переведите их на другую роль в разделе «Сотрудники».')}`
        : t('Роль исчезнет из списка. Сотрудников на ней нет.'),
      danger: true,
      confirmText: t('Удалить'),
    })
    if (!ok) return
    try {
      await api.del(`/roles/${sel.id}`)
      setRoles((ls) => ls.filter((x) => x.id !== sel.id))
      setSelId(OWNER_ROLE_ID)
      toast(t('Роль удалена'))
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const total = useMemo(() => PERMISSION_GROUPS.reduce((s, g) => s + g.items.length, 0), [])

  return (
    <Layout
      title={t('Роли и права')}
      subtitle={t('Кому что можно в аптеке')}
      actions={
        <button className="btn" data-tour="roles.new" onClick={create}>
          <span className="ic"><LuPlus size={16} /></span> {t('Новая роль')}
        </button>
      }
    >
      <div className="roles">
        <aside className="panel roles-list" data-tour="roles.list">
          <h2><span className="h2-title"><span className="ic"><LuShieldCheck size={17} /></span>{t('Роли')}</span></h2>
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              className={'role-item' + (sel?.id === r.id ? ' active' : '')}
              onClick={() => setSelId(r.id)}
            >
              <span className="role-item-main">
                <b>{r.name}</b>
                <span className="tag-cat">
                  {r.people} {t('чел.')} · {r.id === OWNER_ROLE_ID ? t('все права') : `${r.permissions.length} ${t('из')} ${total}`}
                </span>
              </span>
              {r.system && <span className="role-lock" title={t('системная')}><LuLock size={14} /></span>}
            </button>
          ))}
          {!loading && roles.length === 0 && <div className="empty">{t('Ролей пока нет')}</div>}
        </aside>

        {sel && (
          <section className="panel roles-editor" data-tour="roles.rights">
            <div className="roles-editor-head">
              <div className="roles-editor-title">
                <h2>
                  <span className="h2-title">{sel.name}</span>
                </h2>
                {sel.description && <div className="tag-cat">{sel.description}</div>}
              </div>
              <div className="roles-editor-actions">
                {sel.system && <span className="badge transfer">{t('системная')}</span>}
                {!owner && (
                  <button className="btn ghost sm" onClick={rename} title={t('Переименовать')} aria-label={t('Переименовать')}>
                    <LuPencil size={14} /> {t('Изменить')}
                  </button>
                )}
                {!owner && !sel.system && (
                  <button className="btn ghost sm" data-tour="roles.delete" onClick={remove} style={{ color: 'var(--danger)' }}>
                    <LuTrash2 size={14} /> {t('Удалить')}
                  </button>
                )}
                <button className="btn" data-tour="roles.save" onClick={save} disabled={!dirty || saving}>
                  <span className="ic"><LuCheck size={16} /></span> {saving ? t('Сохранение…') : t('Сохранить права')}
                </button>
              </div>
            </div>

            {owner && <div className="note info" style={{ marginBottom: 14 }}>{t('У владельца всегда все права, изменить их нельзя.')}</div>}

            {PERMISSION_GROUPS.map((g) => {
              const keys = g.items.map(([k]) => k)
              const n = keys.filter((k) => has(k)).length
              return (
                <div key={g.key} className="perm-group">
                  <div className="perm-group-head">
                    <h3>{t(g.title)}</h3>
                    {!owner && (
                      <button type="button" className="linklike" onClick={() => toggleGroup(g)}>
                        {n === keys.length ? t('снять все') : t('выбрать все')} {n}/{keys.length}
                      </button>
                    )}
                  </div>
                  <div className="perm-grid">
                    {g.items.map(([key, label]) => (
                      <label key={key} className={'perm' + (has(key) ? ' on' : '') + (owner ? ' locked' : '')}>
                        <input type="checkbox" checked={has(key)} disabled={owner} onChange={() => toggle(key)} />
                        <span>{t(label)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )}
      </div>
    </Layout>
  )
}
