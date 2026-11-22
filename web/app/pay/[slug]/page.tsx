'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePaystackPayment } from 'react-paystack';
import { fetchInvoice, postJson, fmtNgn, fmtUsdc, type InvoiceApiResponse } from '../../../lib/api';
import { depositToEscrow, releaseEscrow, escrowExplorerUrl } from '../../../lib/solana';

/**
 * The buyer/vendor public page. No accounts, no downloads.
 * `?k=<releaseToken>` is the buyer's release capability (fiat rail);
 * USDC releases are wallet-signed on-chain instead.
 */

type Busy = null | 'pay' | 'deposit' | 'release' | 'fiat-sent' | 'dispute';

export default function PayPage({ params }: { params: { slug: string } }) {
  const [data, setData] = useState<InvoiceApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [buyerPhone, setBuyerPhone] = useState('');
  const [buyerWallet, setBuyerWallet] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);

  const releaseKey = useMemo(
    () => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('k')),
    [],
  );
  const { slug } = params;

  const load = useCallback(async () => {
    try {
      setData(await fetchInvoice(slug));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [slug]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);

  const invoice = data?.invoice;
  const escrow = data?.escrow;

  // ── Paystack (fiat checkout) ──────────────────────────────────────────────
  const publicKey = process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY ?? '';
  const initializePayment = usePaystackPayment({
    publicKey,
    email: `buyer+${slug}@safelink.africa`,
    amount: invoice?.amountNgn ?? 0, // kobo
    reference: slug,
    currency: 'NGN',
    metadata: { custom_fields: [{ display_name: 'Order', variable_name: 'order', value: slug }] },
  });

  // react-paystack v4: onSuccess receives no args — we know the reference (it's our slug)
  const onPaystackSuccess = useCallback(async () => {
    setBusy('pay');
    try {
      // Server verifies with Paystack itself — client success is never trusted alone.
      await postJson(`/api/escrows/${slug}/confirm-fiat`, { reference: slug });
      setNotice('Payment confirmed. Funds are now held in escrow 🔒');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [slug, load]);

  // ── Solana deposit (USDC lock) ────────────────────────────────────────────
  const onDeposit = useCallback(async () => {
    if (!data?.solana.programId || !data.solana.usdcMint || !escrow) {
      setError('Solana escrow is not configured yet.');
      return;
    }
    setBusy('deposit');
    try {
      await depositToEscrow({
        rpcUrl: data.solana.rpcUrl,
        programId: data.solana.programId,
        usdcMint: data.solana.usdcMint,
        seed: escrow.escrowSeed,
        amountBaseUnits: invoice?.amountUsdc ?? 0,
      });
      await postJson(`/api/escrows/${slug}/onchain-deposit`);
      setNotice('USDC locked in the vault 🔒 — anyone can verify it on the explorer link below.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [data, escrow, invoice, slug, load]);

  // ── Releases ──────────────────────────────────────────────────────────────
  const onFiatRelease = useCallback(async () => {
    if (!releaseKey) return;
    setBusy('release');
    try {
      await postJson(`/api/escrows/${slug}/release`, { releaseToken: releaseKey });
      setNotice('Funds released to the vendor. Thank you! 🎉');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [releaseKey, slug, load]);

  const onChainRelease = useCallback(
    async (recipientWallet: string) => {
      if (!data?.solana.programId || !data.solana.usdcMint || !data.solana.platformFeeWallet || !escrow) {
        setError('Solana escrow is not configured yet.');
        return;
      }
      setBusy('release');
      try {
        await releaseEscrow({
          rpcUrl: data.solana.rpcUrl,
          programId: data.solana.programId,
          usdcMint: data.solana.usdcMint,
          seed: escrow.escrowSeed,
          recipientWallet,
          platformFeeWallet: data.solana.platformFeeWallet,
        });
        await postJson(`/api/escrows/${slug}/onchain-release`);
        setNotice('Escrow released on-chain 🎉');
        await load();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [data, escrow, slug, load],
  );

  const onFiatSent = useCallback(async () => {
    setBusy('fiat-sent');
    try {
      await postJson(`/api/escrows/${slug}/fiat-sent`, { buyerWallet: buyerWallet || undefined });
      setNotice('Seller notified to verify your naira payment.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [slug, buyerWallet, load]);

  const onDispute = useCallback(async () => {
    setBusy('dispute');
    try {
      await postJson(`/api/escrows/${slug}/dispute`, { fromPhone: buyerPhone, reason: 'Opened from checkout page' });
      setNotice('Dispute recorded — funds frozen until resolution.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, [slug, buyerPhone, load]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="card w-full max-w-md bg-white p-6 text-center shadow-lg rounded-2xl">
          <div className="text-4xl">😕</div>
          <p className="mt-3 font-medium">{error}</p>
        </div>
      </main>
    );
  }
  if (!data || !invoice) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <p className="animate-pulse text-slate-500">Loading order…</p>
      </main>
    );
  }

  const isP2P = invoice.tradeType === 'P2P_CRYPTO';
  const isUsdc = invoice.currency === 'USDC';
  const pending = invoice.status === 'PENDING';
  const held = invoice.status === 'FUNDED_IN_ESCROW' || invoice.status === 'DISPATCHED';
  const done = invoice.status === 'RELEASED';
  const disputed = invoice.status === 'DISPUTED';
  const aiVerified = escrow?.dispatchProof?.aiVerified === true;
  const fiatMarked = Boolean(escrow?.fiatMarkedPaidAt);
  const stepDispatch = invoice.status === 'DISPATCHED' || aiVerified;
  const p2pRecipient = invoice.buyerWalletAddress || buyerWallet;

  return (
    <main className="mx-auto min-h-screen max-w-md px-4 py-6 pb-16">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-slate-500">{isP2P ? 'P2P Escrow' : 'Secure checkout'}</p>
          <h1 className="text-lg font-bold">{data.vendor.businessName}</h1>
        </div>
        <div className="rounded-xl bg-kolo-100 px-3 py-2 text-right">
          <p className="text-xs text-kolo-700">Order</p>
          <p className="font-mono text-xs font-semibold">{slug}</p>
        </div>
      </div>

      {/* Amount + items */}
      <section className="rounded-2xl bg-white p-5 shadow">
        <p className="text-3xl font-bold text-slate-900">{isUsdc ? fmtUsdc(invoice.amountUsdc) : fmtNgn(invoice.amountNgn)}</p>
        {isP2P && invoice.exchangeRate != null && (
          <p className="mt-1 text-sm text-slate-600">
            Rate: ₦{invoice.exchangeRate.toLocaleString('en-NG')} per USDC · buyer pays {fmtNgn(invoice.amountNgn)}
          </p>
        )}
        {!isP2P && (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {invoice.items.map((it, i) => (
              <li key={i} className="flex justify-between py-2">
                <span>
                  {it.quantity}× {it.name}
                </span>
                <span className="text-slate-600">
                  {isUsdc ? fmtUsdc(it.unitPrice * 1_000_000) : fmtNgn(it.unitPrice * 100)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {invoice.isEscrow && (
          <div className="mt-3 rounded-xl bg-kolo-50 p-3 text-xs leading-relaxed text-kolo-700">
            🔒 <strong>Escrow protected:</strong> the vendor cannot withdraw until you confirm delivery (or the 24h timer
            runs out with no dispute).
          </div>
        )}
      </section>

      {/* Status timeline */}
      {held && (
        <section className="mt-4 rounded-2xl bg-white p-5 shadow">
          <Timeline
            steps={[
              { label: 'Payment held in escrow', done: true },
              { label: 'Dispatch verified by AI', done: stepDispatch, pendingText: 'Waiting for vendor proof' },
              { label: 'You confirm & release', done },
            ]}
          />
          {escrow?.dispatchProof && (
            <div className={`mt-3 rounded-xl p-3 text-xs ${aiVerified ? 'bg-kolo-50 text-kolo-700' : 'bg-amber-50 text-amber-700'}`}>
              🤖 <strong>AI audit:</strong> {escrow.dispatchProof.aiSummary}
            </div>
          )}
          {escrow?.onChainVaultAddress && (
            <a
              href={escrowExplorerUrl(escrow.onChainVaultAddress)}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block truncate text-xs text-kolo-600 underline"
            >
              🔗 Verify the vault on Solana Explorer: {escrow.onChainVaultAddress.slice(0, 14)}…
            </a>
          )}
          {escrow?.autoReleaseAt && !done && (
            <p className="mt-2 text-xs text-slate-500">Auto-release: {new Date(escrow.autoReleaseAt).toLocaleString()}</p>
          )}
        </section>
      )}

      {/* PENDING actions */}
      {pending && !isUsdc && (
        <button
          onClick={() => (busy ? null : initializePayment(onPaystackSuccess, () => setNotice('Payment window closed.')))}
          disabled={busy !== null}
          className="mt-4 w-full rounded-2xl bg-kolo-600 py-4 font-semibold text-white shadow hover:bg-kolo-700 disabled:opacity-50"
        >
          {busy === 'pay' ? 'Confirming…' : `Pay ${fmtNgn(invoice.amountNgn)} securely`}
        </button>
      )}

      {pending && isUsdc && (
        <button
          onClick={() => void onDeposit()}
          disabled={busy !== null}
          className="mt-4 w-full rounded-2xl bg-slate-900 py-4 font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === 'deposit' ? 'Locking on-chain…' : `Connect Phantom & lock ${fmtUsdc(invoice.amountUsdc)}`}
        </button>
      )}

      {/* HELD actions */}
      {held && !isP2P && !isUsdc && (
        <button
          onClick={() => void onFiatRelease()}
          disabled={busy !== null || !releaseKey}
          className="mt-4 w-full rounded-2xl bg-kolo-600 py-4 font-semibold text-white shadow hover:bg-kolo-700 disabled:opacity-50"
        >
          {busy === 'release' ? 'Releasing…' : '✅ Confirm delivery & release funds'}
        </button>
      )}
      {held && !isP2P && !isUsdc && !releaseKey && (
        <p className="mt-2 text-center text-xs text-slate-500">
          Release requires the buyer link (sent to the buyer on WhatsApp).
        </p>
      )}

      {held && !isP2P && isUsdc && (
        <button
          onClick={() => void onChainRelease(data.vendor.solanaWalletAddress ?? '')}
          disabled={busy !== null || !data.vendor.solanaWalletAddress}
          className="mt-4 w-full rounded-2xl bg-slate-900 py-4 font-semibold text-white shadow hover:bg-slate-800 disabled:opacity-50"
        >
          {busy === 'release' ? 'Releasing…' : '✅ Confirm delivery & release (wallet-signed)'}
        </button>
      )}

      {/* P2P actions */}
      {held && isP2P && !fiatMarked && (
        <section className="mt-4 rounded-2xl bg-white p-5 shadow">
          <p className="text-sm font-semibold">Buyer: have you sent the naira?</p>
          <input
            value={buyerWallet}
            onChange={(e) => setBuyerWallet(e.target.value)}
            placeholder="Your USDC receiving wallet address"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <button
            onClick={() => void onFiatSent()}
            disabled={busy !== null}
            className="mt-3 w-full rounded-xl bg-kolo-600 py-3 font-semibold text-white hover:bg-kolo-700 disabled:opacity-50"
          >
            {busy === 'fiat-sent' ? 'Notifying…' : '🏦 I have sent the Naira'}
          </button>
        </section>
      )}
      {held && isP2P && fiatMarked && !done && (
        <section className="mt-4 rounded-2xl bg-white p-5 shadow">
          <p className="text-sm font-semibold">Seller: confirm the naira landed, then release</p>
          <input
            value={buyerWallet || invoice.buyerWalletAddress || ''}
            onChange={(e) => setBuyerWallet(e.target.value)}
            placeholder="Buyer's USDC wallet address"
            className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 font-mono text-xs"
          />
          <button
            onClick={() => void onChainRelease(p2pRecipient)}
            disabled={busy !== null || !p2pRecipient}
            className="mt-3 w-full rounded-xl bg-slate-900 py-3 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'release' ? 'Releasing…' : '💸 Release USDC from vault (Phantom)'}
          </button>
          <p className="mt-2 text-xs text-slate-500">Funds go directly to the buyer's wallet minus the 1.5% fee.</p>
        </section>
      )}

      {/* Terminal states */}
      {done && (
        <section className="mt-4 rounded-2xl bg-white p-6 text-center shadow">
          <div className="text-4xl">🎉</div>
          <p className="mt-2 font-semibold">Escrow released</p>
          <p className="mt-1 text-sm text-slate-600">Both parties were notified on WhatsApp.</p>
        </section>
      )}
      {disputed && (
        <section className="mt-4 rounded-2xl bg-amber-50 p-5 text-center text-amber-800 shadow">
          <div className="text-3xl">⚠️</div>
          <p className="mt-2 font-semibold">This order is disputed — funds are frozen</p>
          {escrow?.disputeReason && <p className="mt-1 text-xs">{escrow.disputeReason}</p>}
        </section>
      )}

      {/* Dispute */}
      {held && !disputed && !done && (
        <div className="mt-4 text-center">
          {disputeOpen ? (
            <div className="rounded-2xl bg-white p-4 shadow">
              <input
                value={buyerPhone}
                onChange={(e) => setBuyerPhone(e.target.value)}
                placeholder="Your phone (e.g. 2348012345678)"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void onDispute()}
                disabled={busy !== null || buyerPhone.length < 7}
                className="mt-2 w-full rounded-xl bg-amber-500 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
              >
                {busy === 'dispute' ? 'Opening…' : 'Open dispute & freeze funds'}
              </button>
            </div>
          ) : (
            <button onClick={() => setDisputeOpen(true)} className="text-xs text-slate-400 underline">
              Something wrong? Open a dispute
            </button>
          )}
        </div>
      )}

      {/* Notices */}
      {notice && <p className="mt-4 rounded-xl bg-kolo-50 p-3 text-center text-sm text-kolo-700">{notice}</p>}
      {error && data && <p className="mt-4 rounded-xl bg-red-50 p-3 text-center text-sm text-red-700">{error}</p>}

      <p className="mt-8 text-center text-xs text-slate-400">
        Powered by SafeLink · AI-verified escrow for WhatsApp commerce
      </p>
    </main>
  );
}

function Timeline({ steps }: { steps: Array<{ label: string; done: boolean; pendingText?: string }> }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              s.done ? 'bg-kolo-500 text-white' : 'border border-slate-300 bg-white text-slate-400'
            }`}
          >
            {s.done ? '✓' : i + 1}
          </span>
          <div>
            <p className={`text-sm ${s.done ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{s.label}</p>
            {!s.done && s.pendingText && <p className="text-xs text-slate-400">{s.pendingText}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
