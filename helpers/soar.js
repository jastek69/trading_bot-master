require("dotenv").config()

const crypto = require("crypto")

/**
 * SOAR risk-event emitter.
 *
 * Writes risk events to the blockchain SOAR stack (defi-events) and reads the
 * halt flag that stack sets when it raises a CRITICAL finding.
 *
 * Two rules this module never breaks:
 *
 * 1. It is optional. With SOAR_ENABLED unset, or with AWS unreachable, every
 *    function here degrades to a no-op and the bot trades exactly as it would
 *    without it. Telemetry must never be able to halt trading by failing.
 *
 * 2. It is fail-open on emit and fail-safe on halt: an emit error is logged
 *    and swallowed, but if the halt flag cannot be read we return the last
 *    known value rather than assuming "not halted".
 *
 * Contract (terraform output in the SOAR repo):
 *   defi_events_table_name   -> DEFI_EVENTS_TABLE
 *   defi_tb_halt_parameter   -> DEFI_HALT_PARAM
 *   defi_tb_event_writer_policy_arn attached to whatever principal this runs as
 */

const SOAR_ENABLED = String(process.env.SOAR_ENABLED || "false").toLowerCase() === "true"
const AWS_REGION = process.env.AWS_REGION || "us-west-2"
const EVENTS_TABLE = process.env.DEFI_EVENTS_TABLE || "defi-events"
const HALT_PARAM = process.env.DEFI_HALT_PARAM || "/defi/tb/trading-halted"

// This bot's identity in the shared events table. The correlation agent keys
// its per-project halt flags off this exact value.
const COMPONENT = "trading-bot"

// Events age out of the table on their own so the correlation scan stays cheap.
const EVENT_TTL_SECONDS = 14 * 24 * 60 * 60

// Halt flag is polled, not pushed. Cache briefly so a per-trade check does not
// become a per-trade SSM call.
const HALT_CACHE_MS = 30_000

let dynamoClient = null
let ssmClient = null
let haltCache = { value: false, checkedAt: 0 }

function clients() {
  if (!dynamoClient) {
    // Required lazily so the bot runs without the AWS SDK installed when
    // SOAR_ENABLED is false.
    const { DynamoDBClient } = require("@aws-sdk/client-dynamodb")
    const { SSMClient } = require("@aws-sdk/client-ssm")

    dynamoClient = new DynamoDBClient({ region: AWS_REGION })
    ssmClient = new SSMClient({ region: AWS_REGION })
  }

  return { dynamoClient, ssmClient }
}

/**
 * Event types the correlation agent scores. Anything not listed still records,
 * but scores at the unknown-event weight.
 */
const EVENT_TYPES = {
  TRADE_REVERTED: "TRADE_REVERTED",
  SLIPPAGE_EXCEEDED: "SLIPPAGE_EXCEEDED",
  PROFIT_ANOMALY: "PROFIT_ANOMALY",
  SANDWICH_SUSPECTED: "SANDWICH_SUSPECTED",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  UNWIND_FAILED: "UNWIND_FAILED",
  HEALTH_FACTOR_LOW: "HEALTH_FACTOR_LOW",
  RPC_DEGRADED: "RPC_DEGRADED",
  BOT_ERROR: "BOT_ERROR",
}

/**
 * Emit one risk event. Never throws.
 *
 * @param {object} event
 * @param {string} event.type      one of EVENT_TYPES
 * @param {string} [event.pair]    e.g. "WETH/USDC"
 * @param {string} [event.txHash]
 * @param {number} [event.valueUsd] capital implicated, used for value-at-risk
 * @param {string} [event.detail]  short human-readable context
 */
async function emitDefiEvent(event) {
  if (!SOAR_ENABLED) return false

  const now = new Date()
  const epoch = Math.floor(now.getTime() / 1000)

  const item = {
    event_id: { S: `${COMPONENT}-${now.toISOString()}-${crypto.randomUUID()}` },
    event_type: { S: String(event.type || "BOT_ERROR") },
    event_epoch: { N: String(epoch) },
    created_at: { S: now.toISOString() },
    component: { S: COMPONENT },
    chain: { S: process.env.DEFI_CHAIN || "ethereum" },
    expires_at: { N: String(epoch + EVENT_TTL_SECONDS) },
  }

  if (event.pair) item.pair = { S: String(event.pair) }
  if (event.txHash) item.tx_hash = { S: String(event.txHash) }
  if (event.detail) item.detail = { S: String(event.detail).slice(0, 1024) }
  if (Number.isFinite(event.valueUsd)) {
    item.value_usd = { N: String(event.valueUsd) }
  }

  try {
    const { PutItemCommand } = require("@aws-sdk/client-dynamodb")
    const { dynamoClient } = clients()

    await dynamoClient.send(
      new PutItemCommand({ TableName: EVENTS_TABLE, Item: item })
    )

    return true
  } catch (error) {
    // Telemetry failure must not interrupt trading.
    console.log(`[soar] failed to emit ${item.event_type.S}: ${error.message}`)
    return false
  }
}

/**
 * Has the SOAR stack halted this bot?
 *
 * On a read failure the last known value is returned rather than false, so a
 * transient SSM outage cannot silently un-halt a bot that was halted.
 */
async function isTradingHalted() {
  if (!SOAR_ENABLED) return false

  const now = Date.now()

  if (now - haltCache.checkedAt < HALT_CACHE_MS) {
    return haltCache.value
  }

  try {
    const { GetParameterCommand } = require("@aws-sdk/client-ssm")
    const { ssmClient } = clients()

    const response = await ssmClient.send(
      new GetParameterCommand({ Name: HALT_PARAM })
    )

    const halted =
      String(response.Parameter?.Value || "false").toLowerCase() === "true"

    haltCache = { value: halted, checkedAt: now }

    return halted
  } catch (error) {
    console.log(
      `[soar] could not read halt flag (${error.message}); ` +
        `keeping last known value: ${haltCache.value}`
    )

    return haltCache.value
  }
}

module.exports = {
  EVENT_TYPES,
  emitDefiEvent,
  isTradingHalted,
  SOAR_ENABLED,
}
