import { randomUUID } from 'node:crypto'
import { query, transaction, type Tx } from '../pool.js'

/** A compaction identity, not a content revision or a permission epoch. */
export const stateGenerationRepo = {
  async readTx(tx: Tx, name: string): Promise<string | null> {
    const rows = await tx.query<{ generation: string }>(
      'SELECT generation FROM doc_state_generation WHERE document_name = ? FOR UPDATE', [name],
    )
    return rows[0]?.generation ?? null
  },
  async ensureSheetTx(tx: Tx, name: string): Promise<string | null> {
    const meta = await tx.query<{ doc_type: string }>('SELECT doc_type FROM doc_meta WHERE document_name = ?', [name])
    if (meta[0]?.doc_type !== 'sheet') return null
    await tx.query('INSERT IGNORE INTO doc_state_generation (document_name, generation) VALUES (?, ?)', [name, randomUUID()])
    return this.readTx(tx, name)
  },
  async ensureSheet(name: string): Promise<string | null> {
    return transaction(tx => this.ensureSheetTx(tx, name))
  },
  async current(name: string): Promise<string | null> {
    const rows = await query<{ generation: string }>('SELECT generation FROM doc_state_generation WHERE document_name = ?', [name])
    return rows[0]?.generation ?? null
  },
  async rotateTx(tx: Tx, name: string): Promise<string | null> {
    if (!(await this.ensureSheetTx(tx, name))) return null
    const generation = randomUUID()
    await tx.query('UPDATE doc_state_generation SET generation = ? WHERE document_name = ?', [generation, name])
    return generation
  },
}
