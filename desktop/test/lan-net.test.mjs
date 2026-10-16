// ── Обмен кассами по местной сети: настоящая сеть ──
//
// Две «кассы» в одном процессе разговаривают по настоящим сокетам на 127.0.0.1:
// у каждой своя локальная база, свой порт и тот же общий ключ магазина. Проверяем, что
// данные идут в обе стороны по одному звонку, что чужой ключ не пускает, что свой же
// адрес распознаётся, и что шифрование и разбор адресов работают как задумано.
//
// Запуск: npm test (в папке desktop)
import test from 'node:test'
import assert from 'node:assert/strict'
import { broadcastAddrs, createLan, lanKeys, parseAddress, seal, unseal } from '../src/lan.mjs'
import { listDocs } from '../src/local/docs.mjs'
import {
  lanAddManual,
  lanCatchUp,
  lanEntriesSince,
  lanGen,
  lanManual,
  lanPeer,
  lanPeerProgress,
  lanPeers,
  lanPeerSeen,
  lanReceive,
} from '../src/local/lan.mjs'
import { checkout } from '../src/local/ops/sale.mjs'
import { unitsOf } from '../src/local/stock.mjs'
import { q } from '../src/local/db.mjs'
import { ctx, NOW, pharmacy, product } from '../test-support/pharmacy.mjs'

const KEY = 'a'.repeat(43)
const OTHER_KEY = 'b'.repeat(43)
const shop = () => pharmacy({ products: [product({ id: 'nur', name: 'Нурофен', price: 150, cost: 100, stock: 9 })] })
const quiet = { info() {}, warn() {} }

function hubFor(db, deviceId, name, key, { wide = true } = {}) {
  return {
    state: () => ({ enabled: true, key, deviceId, name, wide }),
    entriesFor(since, w) {
      lanCatchUp(db, { deviceId, now: NOW })
      return lanEntriesSince(db, since, { wide: w })
    },
    receive(peerId, entries) {
      lanReceive(db, entries, { now: NOW, gen: lanGen(db) })
    },
    progress: (id, p) => lanPeerProgress(db, id, p),
    peers: () => lanPeers(db),
    peer: (id) => lanPeer(db, id),
    peerSeen: (p) => lanPeerSeen(db, p),
    manual: () => lanManual(db),
    forgetAddress: (id) => q(db, "UPDATE lan_peers SET address = '' WHERE deviceId = ?").run(id),
  }
}

// Касса с сетью на свободном порту. Таймеры — пустые: обмен проверка зовёт сама
function kassa(db, deviceId, name, key = KEY, opts = {}) {
  const lan = createLan({
    hub: hubFor(db, deviceId, name, key, opts),
    log: quiet,
    now: () => NOW,
    tcpPort: 0,
    udpPort: 0,
    bindAddress: '127.0.0.1',
    timers: { set: () => null, clear() {}, every: () => null, stop() {} },
  })
  return lan
}

test('шифрование: своим ключом читается, чужим — нет, подмена ломает сообщение', () => {
  const a = lanKeys(KEY)
  const b = lanKeys(OTHER_KEY)
  assert.equal(a.tag.length, 24)
  assert.notEqual(a.tag, b.tag)
  const sealed = seal(a.enc, { hello: 'мир', n: 1 })
  assert.deepEqual(unseal(a.enc, sealed), { hello: 'мир', n: 1 })
  assert.throws(() => unseal(b.enc, sealed))
  const broken = Buffer.from(sealed)
  broken[broken.length - 1] ^= 1
  assert.throws(() => unseal(a.enc, broken))
  // Отпечаток магазина ключа не выдаёт и одинаков у всех касс магазина
  assert.equal(lanKeys(KEY).tag, a.tag)
})

test('адрес соседа, вписанный вручную', () => {
  assert.deepEqual(parseAddress(' 192.168.1.10 '), { host: '192.168.1.10', port: 47810, text: '192.168.1.10' })
  assert.deepEqual(parseAddress('KASSA-2:47812'), { host: 'KASSA-2', port: 47812, text: 'KASSA-2:47812' })
  assert.equal(parseAddress(''), null)
  assert.equal(parseAddress('http://x'), null)
  assert.equal(parseAddress('1.2.3.4:99999'), null)
  assert.equal(parseAddress('a b'), null)
})

test('широковещательные адреса считаются по маске каждой сети', () => {
  const os = {
    networkInterfaces: () => ({
      eth: [{ family: 'IPv4', address: '192.168.1.23', netmask: '255.255.255.0', internal: false }],
      cable: [{ family: 'IPv4', address: '169.254.10.5', netmask: '255.255.0.0', internal: false }],
      lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
      v6: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false }],
    }),
  }
  assert.deepEqual(broadcastAddrs(os).sort(), ['169.254.255.255', '192.168.1.255', '255.255.255.255'])
})

test('две кассы по сети: продажи обеих видны на обеих за один звонок', async () => {
  const dbA = shop()
  const dbB = shop()
  const A = kassa(dbA, 'kassa-A', 'Касса 1')
  const B = kassa(dbB, 'kassa-B', 'Касса 2')
  try {
    await A.sync()
    await B.sync()
    assert.ok(A.port() > 0 && B.port() > 0)

    const saleA = checkout(ctx(dbA, { deviceId: 'kassa-A' }), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
    const saleB = checkout(ctx(dbB, { deviceId: 'kassa-B' }), { items: [{ productId: 'nur', qty: 3 }], payment: 'card' })

    // Касса B знает адрес A (вписан вручную) — звонит она; A никому не звонит
    lanAddManual(dbB, `127.0.0.1:${A.port()}`, NOW)
    await B.now()

    assert.deepEqual(listDocs(dbB, 'sale').map((s) => s.id).sort(), [saleA.id, saleB.id].sort())
    assert.deepEqual(listDocs(dbA, 'sale').map((s) => s.id).sort(), [saleA.id, saleB.id].sort())
    // Остаток на обеих: 9 − 2 − 3
    assert.equal(unitsOf(dbA, 'nur', NOW).units, 4)
    assert.equal(unitsOf(dbB, 'nur', NOW).units, 4)

    // Обе знают друг друга по имени; у B — «на связи»
    const st = B.status()
    assert.equal(st.running, true)
    assert.equal(st.listening, true)
    assert.equal(st.peers.length, 1)
    assert.equal(st.peers[0].name, 'Касса 1')
    assert.equal(st.peers[0].online, true)
    assert.equal(A.status().peers[0].name, 'Касса 2')

    // Новая продажа на A доходит до B следующим звонком, без повторов старого
    checkout(ctx(dbA, { deviceId: 'kassa-A' }), { items: [{ productId: 'nur', qty: 1 }], payment: 'cash' })
    await B.now()
    assert.equal(listDocs(dbB, 'sale').length, 3)
    assert.equal(unitsOf(dbB, 'nur', NOW).units, 3)
  } finally {
    A.stop()
    B.stop()
  }
})

test('касса с чужим ключом (другой магазин) ничего не получает', async () => {
  const dbA = shop()
  const dbX = shop()
  const A = kassa(dbA, 'kassa-A', 'Касса 1', KEY)
  const X = kassa(dbX, 'kassa-X', 'Чужая', OTHER_KEY)
  try {
    await A.sync()
    await X.sync()
    checkout(ctx(dbA, { deviceId: 'kassa-A' }), { items: [{ productId: 'nur', qty: 2 }], payment: 'cash' })
    lanAddManual(dbX, `127.0.0.1:${A.port()}`, NOW)
    await X.now()
    assert.equal(listDocs(dbX, 'sale').length, 0)
    assert.equal(X.status().manual[0].error, 'key')
    assert.equal(lanPeers(dbA).length, 0)
  } finally {
    A.stop()
    X.stop()
  }
})

test('вписан адрес этого же компьютера — понятная ошибка, не зацикливание', async () => {
  const dbA = shop()
  const A = kassa(dbA, 'kassa-A', 'Касса 1')
  try {
    await A.sync()
    lanAddManual(dbA, `127.0.0.1:${A.port()}`, NOW)
    await A.now()
    assert.equal(A.status().manual[0].error, 'self')
  } finally {
    A.stop()
  }
})

test('выключенный обмен не слушает сеть', async () => {
  const db = shop()
  const lan = createLan({
    hub: { ...hubFor(db, 'k', 'K', KEY), state: () => ({ enabled: false, key: KEY, deviceId: 'k', name: 'K', wide: true }) },
    log: quiet,
    now: () => NOW,
    tcpPort: 0,
    udpPort: 0,
    bindAddress: '127.0.0.1',
    timers: { set: () => null, clear() {}, every: () => null, stop() {} },
  })
  await lan.sync()
  assert.equal(lan.status().running, false)
  assert.equal(lan.port(), 0)
})
