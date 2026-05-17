import cors from "cors";
import express from "express";

const app = express();
const port = process.env.PORT || 3001;
const REFILL_AMOUNT = 2000;

const demoUser = {
  id: "demo-user",
  username: "demo-player",
  displayName: "Demo Player",
  billingProfile: "frontend-wallet-sync",
};

const wallet = {
  userId: demoUser.id,
  currency: "COINS",
  balance: 5000,
  version: 1,
  updatedAt: new Date().toISOString(),
};

const ledger = [];
const refillRequests = [];

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function now() {
  return new Date().toISOString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeRefillRequest(requestRecord) {
  return {
    id: requestRecord.id,
    guestId: requestRecord.guestId,
    amount: requestRecord.amount,
    status: requestRecord.status,
    createdAt: requestRecord.createdAt,
    approvedAt: requestRecord.approvedAt,
    rejectedAt: requestRecord.rejectedAt,
    claimedAt: requestRecord.claimedAt,
    updatedAt: requestRecord.updatedAt,
  };
}

function createRefillRequestId() {
  return `refill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseGuestId(value) {
  const guestId = String(value ?? "").trim();
  if (!guestId) {
    throw new Error("A guestId is required.");
  }

  if (guestId.length > 120) {
    throw new Error("guestId is too long.");
  }

  return guestId;
}

function getRefillRequest(requestId) {
  return refillRequests.find((entry) => entry.id === requestId) ?? null;
}

function getActiveRefillRequestForGuest(guestId) {
  return (
    refillRequests.find(
      (entry) => entry.guestId === guestId && (entry.status === "pending" || entry.status === "approved"),
    ) ?? null
  );
}

function updateRefillRequestStatus(requestRecord, status) {
  const updatedAt = now();
  requestRecord.status = status;
  requestRecord.updatedAt = updatedAt;

  if (status === "approved") {
    requestRecord.approvedAt = updatedAt;
  }

  if (status === "rejected") {
    requestRecord.rejectedAt = updatedAt;
  }

  if (status === "claimed") {
    requestRecord.claimedAt = updatedAt;
  }

  return requestRecord;
}

function renderActionButtons(requestRecord) {
  if (requestRecord.status !== "pending") {
    return '<span class="muted">No actions</span>';
  }

  return `
    <div class="actions">
      <form method="post" action="/admin/refill-requests/${encodeURIComponent(requestRecord.id)}/approve">
        <button type="submit" class="approve">Approve +${requestRecord.amount}</button>
      </form>
      <form method="post" action="/admin/refill-requests/${encodeURIComponent(requestRecord.id)}/reject">
        <button type="submit" class="reject">Reject</button>
      </form>
    </div>
  `;
}

function renderRefillRequestsAdminPage() {
  const requestRows = refillRequests.length
    ? refillRequests
        .map(
          (requestRecord) => `
            <tr>
              <td><code>${escapeHtml(requestRecord.id)}</code></td>
              <td><code>${escapeHtml(requestRecord.guestId)}</code></td>
              <td>${escapeHtml(requestRecord.status)}</td>
              <td>${requestRecord.amount}</td>
              <td>${escapeHtml(requestRecord.createdAt)}</td>
              <td>${escapeHtml(requestRecord.approvedAt ?? "-")}</td>
              <td>${escapeHtml(requestRecord.claimedAt ?? "-")}</td>
              <td>${renderActionButtons(requestRecord)}</td>
            </tr>
          `,
        )
        .join("")
    : '<tr><td colspan="8" class="muted">No refill requests yet.</td></tr>';

  const pendingCount = refillRequests.filter((entry) => entry.status === "pending").length;
  const approvedCount = refillRequests.filter((entry) => entry.status === "approved").length;
  const claimedCount = refillRequests.filter((entry) => entry.status === "claimed").length;

  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="refresh" content="5" />
        <title>Guest refill requests</title>
        <style>
          :root {
            color-scheme: dark;
            font-family: Arial, sans-serif;
          }
          body {
            margin: 0;
            padding: 24px;
            background: #081021;
            color: #f3f7ff;
          }
          h1, h2, p {
            margin-top: 0;
          }
          .summary {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-bottom: 20px;
          }
          .card {
            min-width: 140px;
            padding: 14px 16px;
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.08);
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(255, 255, 255, 0.04);
            border-radius: 18px;
            overflow: hidden;
          }
          th, td {
            padding: 12px 14px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            vertical-align: top;
          }
          th {
            color: #ffe08a;
            font-size: 0.86rem;
            letter-spacing: 0.05em;
            text-transform: uppercase;
          }
          code {
            color: #bfe3ff;
          }
          .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          form {
            margin: 0;
          }
          button {
            cursor: pointer;
            border: 0;
            border-radius: 12px;
            padding: 10px 14px;
            font-weight: 700;
          }
          .approve {
            background: #6be49a;
            color: #10223a;
          }
          .reject {
            background: #ff9696;
            color: #401515;
          }
          .muted {
            color: #abc0e5;
          }
        </style>
      </head>
      <body>
        <h1>Guest refill requests</h1>
        <p class="muted">Open this page to approve a pending guest request. Approved requests add ${REFILL_AMOUNT} coins after the guest browser polls and claims the refill.</p>
        <div class="summary">
          <div class="card"><strong>Pending</strong><br />${pendingCount}</div>
          <div class="card"><strong>Approved</strong><br />${approvedCount}</div>
          <div class="card"><strong>Claimed</strong><br />${claimedCount}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Guest</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Created</th>
              <th>Approved</th>
              <th>Claimed</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${requestRows}</tbody>
        </table>
      </body>
    </html>
  `;
}

app.get("/api/me", (_request, response) => {
  response.json({
    user: demoUser,
    wallet: {
      currency: wallet.currency,
      balance: wallet.balance,
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    },
  });
});

app.get("/api/wallet", (_request, response) => {
  response.json({
    userId: wallet.userId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    updatedAt: wallet.updatedAt,
  });
});

app.post("/api/refill-requests", (request, response) => {
  try {
    const guestId = parseGuestId(request.body?.guestId);
    const activeRequest = getActiveRefillRequestForGuest(guestId);

    if (activeRequest) {
      response.json({
        request: serializeRefillRequest(activeRequest),
        reusedExistingRequest: true,
      });
      return;
    }

    const createdAt = now();
    const requestRecord = {
      id: createRefillRequestId(),
      guestId,
      amount: REFILL_AMOUNT,
      status: "pending",
      createdAt,
      approvedAt: null,
      rejectedAt: null,
      claimedAt: null,
      updatedAt: createdAt,
    };

    refillRequests.unshift(requestRecord);

    response.status(201).json({
      request: serializeRefillRequest(requestRecord),
      reusedExistingRequest: false,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not create refill request.",
    });
  }
});

app.get("/api/refill-requests/:requestId", (request, response) => {
  try {
    const guestId = parseGuestId(request.query?.guestId);
    const requestRecord = getRefillRequest(request.params.requestId);

    if (!requestRecord || requestRecord.guestId !== guestId) {
      response.status(404).json({ error: "Refill request not found." });
      return;
    }

    response.json({
      request: serializeRefillRequest(requestRecord),
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not load refill request.",
    });
  }
});

app.post("/api/refill-requests/:requestId/claim", (request, response) => {
  try {
    const guestId = parseGuestId(request.body?.guestId);
    const requestRecord = getRefillRequest(request.params.requestId);

    if (!requestRecord || requestRecord.guestId !== guestId) {
      response.status(404).json({ error: "Refill request not found." });
      return;
    }

    if (requestRecord.status !== "approved") {
      response.status(409).json({
        error: `Refill request is ${requestRecord.status} and cannot be claimed.`,
      });
      return;
    }

    updateRefillRequestStatus(requestRecord, "claimed");

    response.json({
      request: serializeRefillRequest(requestRecord),
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Could not claim refill request.",
    });
  }
});

app.get("/admin/refill-requests", (_request, response) => {
  response.type("html").send(renderRefillRequestsAdminPage());
});

app.post("/admin/refill-requests/:requestId/approve", (request, response) => {
  const requestRecord = getRefillRequest(request.params.requestId);

  if (requestRecord && requestRecord.status === "pending") {
    updateRefillRequestStatus(requestRecord, "approved");
  }

  response.redirect("/admin/refill-requests");
});

app.post("/admin/refill-requests/:requestId/reject", (request, response) => {
  const requestRecord = getRefillRequest(request.params.requestId);

  if (requestRecord && requestRecord.status === "pending") {
    updateRefillRequestStatus(requestRecord, "rejected");
  }

  response.redirect("/admin/refill-requests");
});

app.post("/api/wallet/settle", (request, response) => {
  try {
    const previousBalance = Number(request.body?.previousBalance);
    const nextBalance = Number(request.body?.nextBalance);
    const delta = Number(request.body?.delta ?? nextBalance - previousBalance);
    const reason = String(request.body?.reason ?? "frontend_resolution");

    if (!Number.isFinite(previousBalance) || !Number.isFinite(nextBalance) || !Number.isFinite(delta)) {
      throw new Error("Wallet settlement requires numeric balances and delta.");
    }

    const driftDetected = wallet.balance !== previousBalance;
    wallet.balance = nextBalance;
    wallet.version += 1;
    wallet.updatedAt = new Date().toISOString();

    ledger.push({
      id: `${wallet.version}-${Date.now()}`,
      userId: wallet.userId,
      previousBalance,
      nextBalance,
      delta,
      reason,
      driftDetected,
      recordedAt: wallet.updatedAt,
    });

    response.json({
      wallet: {
        userId: wallet.userId,
        currency: wallet.currency,
        balance: wallet.balance,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
      driftDetected,
    });
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unknown wallet settlement error.",
    });
  }
});

app.listen(port, () => {
  console.log(`Whacky Slot account service listening on http://localhost:${port}`);
});
