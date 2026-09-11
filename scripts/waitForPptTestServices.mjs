// CI's disposable services must be ready before the test creates its schema.
import mysql from 'mysql2/promise'
import { Redis } from 'ioredis'
import process from 'node:process'
import { setTimeout } from 'node:timers'
if (!/^ppt_case_test_[a-z0-9_]+$/.test(process.env.MYSQL_DATABASE ?? '')) throw new Error('Requires a dedicated PPT test database')
for (let attempt = 0; ; attempt++) {
  let conn
  const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379), lazyConnect: true, retryStrategy: null, connectTimeout: 2000 })
  redis.on('error', () => {})
  try {
    conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT ?? 3306),
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE, connectTimeout: 2000 })
    await conn.ping()
    await redis.connect()
    await redis.ping()
    break
  } catch {
    if (attempt >= 45) throw new Error('Disposable MySQL/Redis services did not become ready')
    await new Promise(resolve => setTimeout(resolve, 1000))
  } finally {
    redis.disconnect()
    if (conn) await conn.end()
  }
}
