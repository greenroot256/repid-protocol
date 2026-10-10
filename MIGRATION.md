# RepID – Guía de migración: empezar desde 0 con un desarrollo limpio

> Documento generado para tener **todo lo necesario** para reconstruir RepID desde cero sin ambigüedad. Se basa en el estado verificado del repositorio (`0.5.0`), en las especificaciones normativas y en la evidencia real existente.

## 1. Objetivo

RepID es un protocolo de reputación descentralizado sobre **Bitcoin Cash (BCH)** usando **CashTokens** y **CashScript**. El principio central (innegociable) es:

> **La cadena almacena hechos inmutables. La interpretación de esos hechos permanece fuera de cadena.**

El objetivo de este documento es permitir a quien parta desde cero implementar de forma limpia: qué es normativo, qué es demostrativo (demo), qué debe conservarse tal cual, qué límites existen y cómo validar con la misma evidencia que usa el proyecto.

## 2. Fuentes normativas (precedencia)

La precedencia aplicable es:

1. `constitution.md` – Principios innegociables (artículos 1–10)
2. `spec/SPEC-008-repid-protocol.md` – Núcleo normativo (principios, modelo, 8 hechos, reglas on-chain, verificación, reputación, seguridad, interoperabilidad, conformidad)
3. `spec/SPEC-009-repid-wire-format-and-recognition.md` – Formato de cable byte-a-byte + algoritmo de reconocimiento
4. Resto de `spec/SPEC-001`..`SPEC-007`, `SPEC-010`

Versión actual del protocolo: **`0.5.0`** (registrado en `protocol/protocol-version.json`).

## 3. Modelo conceptual

- **Identidad**: NFT inmutable bloqueado en `IdentityVault` junto con colateral en BCH. Solo se acuña vía `mint` (genesis con `nftCommitment = ownerPkh`). El colateral **nunca baja** on-chain (`increaseCollateral` exige >= valor previo). Se devuelve íntegro al owner en `burn`. 
- **Recibo (Receipt)**: NFT acuñado **únicamente con firma conjunta** de ambas partes. En la misma transacción de génesis se crean **dos Rating Rights** (uno por parte), bloqueados a `RatingRightVault`. Es la capa anti-corrupción.
- **Rating Right**: UTXO con NFT de derecho, bloqueado a `RatingRightVault`. Tiene **único camino de gasto**: destruir el NFT. Gastarlo **es** emitir la calificación.
- **Calificación (RATING)**: se emite gastando un Rating Right. Lleva `OP_RETURN` con `score` 1–5. Bajo `REPID_RATING2` añade `commentHash`.
- **Retracción (RATING_RETRACTION)**: gasto P2PKH del propio rater con `OP_RETURN` `REPID_RETRACT1` referenciando el recibo cuya calificación se retrae. No borra la calificación original.
- **Confirmación de plataforma (PLATFORM_CONFIRMATION)**: gasto P2PKH de plataforma con `REPID_PLATFORM1` referenciando `receiptTxid`. No requiere identidad.
- **Trust Link (TRUST_LINK)**: gasto P2PKH unilateral con `REPID_TRUST1` hacia `trustedPkh`. Auto-referencia (`truster == trusted`) → inválido.
- **Formas legadas**: `IdentityGenesisValidator` (NFT directo a P2PKH, sin colateral) debe seguir reconociéndose.

## 4. Los 8 hechos

| Tipo | Campos relevantes | Notas |
|---|---|---|
| `IDENTITY_GENESIS` | `txid`, `identityCategory`, `ownerPkh`, `collateral`, `identityOutpoint` | Vault canónico. Legado P2PKH también reconocido. |
| `IDENTITY_COLLATERAL_TOP_UP` | `txid`, `identityCategory`, `ownerPkh`, `newCollateral`, `identityOutpoint`, `previousOutpoint` | Distinto de mint: mismo NFT, nuevo >= anterior. |
| `IDENTITY_BURNED` | `txid`, `identityCategory`, `ownerPkh`, `returnedCollateral`, `identityOutpoint` | Destruye NFT. `returnedCollateral` reconstruido desde último hecho de esa identidad. |
| `RECEIPT_GENESIS` | `txid`, `receiptCategory`, `receiptOwnerPkh`, `ratingRights[]`, `receiptContext?` | Requiere firmas conjuntas. `receiptContext` puede ser 4-byte (`0x10`) o 36-byte (`0x11`) con `contextHash`. |
| `RATING_ISSUED` | `txid`, `spentOutpoint`, `raterPkh`, `rateePkh`, `score`, `valid`, `commentHash?` | Gasta `RatingRightVault`. `commentHash` solo presente con `REPID_RATING2`. |
| `RATING_RETRACTION` | `txid`, `raterPkh`, `receiptTxid`, `valid` | Unilateral por rater. No elimina `RATING_ISSUED`. |
| `PLATFORM_CONFIRMATION` | `txid`, `platformPkh`, `receiptTxid`, `valid` | Validado contra recibos ya indexados. Desde `0.4.0` inválido si plataforma es parte del recibo. |
| `TRUST_LINK` | `txid`, `trusterPkh`, `trustedPkh`, `valid` | Inválido si `trusterPkh == trustedPkh`. |

Esquema normativo: `protocol/schemas/repid-fact.schema.json` (validado por `conformance/schema.test.mjs`).

## 5. Contratos CashScript

Fuentes canónicas (`repid-protocol/contracts/`):

| Contrato | Finalidad | Notas |
|---|---|---|
| `identity_vault.cash` | Vault identidad (mint/increaseCollateral/burn) | Añade `require(this.age >= 144)` en burn desde `0.4.0`. `this.age` = edad del UTXO gastado. `increaseCollateral` **no** retrasa. Top-up **reinicia** el reloj. |
| `identity_vault_0_3_0.cash` | Frozen body 0.3.0 | Sin gate de burn delay. Se conserva para trazabilidad/versionado. |
| `receipt_genesis.cash` | Génesis de recibo + 2 Rating Rights | Requiere ambas firmas. Genera los 3 NFTs con patrón cruzado de commitments. |
| `rating_right.cash` | `RatingRightVault` | **Único path** destruye el NFT. Garantía covenant (no solo "single-spend"). |
| `identity_genesis.cash` | Legado | Forma P2PKH sin colateral. Solo lectura. |

**Compilador:** `cashc 0.13.2`. Artefactos: `protocol/artifacts/*.json`. `npm run artifacts:check` compara bytecode/interfaz/source/debug bytecode exactos. El fingerprint **no** es ancla de conformidad.

## 6. Formato wire (OP_RETURN) byte-a-byte

Reglas estrictas:

- Solo **direct pushes** (1–75 bytes)
- Rechazar otras formas, push 0, o push que reclame más bytes
- **>= 2 pushes**: tag + payload
- Comparación **exacta** del tag
- Validar chunks/longitudes **antes** de leer
- Tag no coincide → **sin hecho**
- Tag coincide pero formato erróneo → **hecho inválido** (`valid:false`)

### 6.1 Tags

| Tag | Bytes ASCII | Chunks | Payload |
|---|---|---|---|
| `REPID_RATING1` | `52 45 50 49 44 5f 52 41 54 49 4e 47 31` (13) | 2 | 1 byte (`score 1-5`) |
| `REPID_RATING2` | `52 45 50 49 44 5f 52 41 54 49 4e 47 32` (13) | 3 | `score(1) + commentHash(32)` |
| `REPID_PLATFORM1` | `52 45 50 49 44 5f 50 4c 41 54 46 4f 52 4d 31` (15) | 2 | `receiptTxid(32)` |
| `REPID_RETRACT1` | `52 45 50 49 44 5f 52 45 54 52 41 43 54 31` (14) | 2 | `receiptTxid(32)` |
| `REPID_TRUST1` | `52 45 50 49 44 5f 54 52 55 53 54 31` (12) | 2 | `trustedPkh(20)` |

### 6.2 commentHash (REPID_RATING2)

Preimagen normativa (0.5.0):

```
REPID-CMT-V1 (12 ASCII) ‖ receiptCategory (32 bytes, display order) ‖ raterPkh (20 bytes) ‖ saltLen (1 byte, 16–32) ‖ salt (saltLen bytes) ‖ comment (UTF-8 NFC)
```

SHA256 una vez. `salt` fuera de cadena. `receiptCategory` del recibo objetivo.

### 6.3 contextHash / receiptContext

- `0x10` (4B): `0x01|0x00` + `interactionCategory(2)` + `roleA(1)` + `roleB(1)`
- `0x11` (36B): añade `contextHash(32)`
Prefijo RCTX-V1: 13 bytes. `contextHash` **sin preimagen publicada**.

## 7. Reconocimiento (orden + estado)

Orden: (1) gasto Identity, (2) IDENTITY_GENESIS, (3) RECEIPT_GENESIS, (4) RATING_ISSUED, (5) PLATFORM_CONFIRMATION, (6) RATING_RETRACTION, (7) TRUST_LINK.

Estado mínimo: Live Rating Rights, Indexed receipt txids, Tracked vault outputs, Issued ratings, Receipt interaction contexts, Retracted ratings set. Persistir.

Resultados: válido (`valid:true`), inválido (`valid:false`), sin hecho.

## 8. Versionado

`0.5.0`. SDK soporta `['0.3.0','0.4.0','0.5.0']`, tripwire `0.6.0`. Reader-superset sobre `0.4.0`. Tag lleva revisión. < 1.0.0 hasta cumplir criterios independientes.

## 9. Evidencia

(a) real txid Chipnet, (b) VM local, (c) reconocimiento. Burn = (b), top-up/retraction = (c), resto (a) según matriz §9 del documento original.

## 10. Comandos de validación

Protocol: `npm test`, `node --test "conformance/*.test.mjs"`, `npm run specs:check`, `requirements:check`, `encoding:check`, `artifacts:check` → 60/60.

SDK: `npm run check:all` → 150/150.

Demo: `npm test` → 35/38.

## 11. Regla de oro

Precedencia specs > descripción. Si ambiguo: **no adivinar**, usar SPEC-008/009 + tests.
