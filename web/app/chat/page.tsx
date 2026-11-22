'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Meta-independent chat surface for the SAME AI agent backend
 * (POST /api/chat -> handleText -> tools -> escrow engine).
 * WhatsApp joins later through the webhook route with zero engine changes.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface Msg {
  role: 'user' | 'bot';
  text: string;
  image?: string; // object url preview
  ts: number;
}

const SUGGESTIONS = [
  'Abeg invoice 2 Airpods Pro, 60k total, for Chioma with escrow',
  'How much I don make this week?',
  'I wan sell 100 USDC for 165k',
];

export default function ChatPage() {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachment, setAttachment] = useState<{ base64: string; mime: string; preview: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = localStorage.getItem('safelink_phone');
    const n = localStorage.getItem('safelink_name');
    if (p && n) {
      setPhone(p);
      setName(n);
      setJoined(true);
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  function join() {
    if (phone.replace(/\D/g, '').length < 7 || !name.trim()) return;
    localStorage.setItem('safelink_phone', phone);
    localStorage.setItem('safelink_name', name);
    setJoined(true);
    setMessages([{ role: 'bot', text: `SafeLink dey here 💪 (${name.trim()}). Tell me wetin you wan sell — e.g. "Invoice 2 sneakers 45k for Tunde with escrow" — or ask about your money.`, ts: Date.now() }]);
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attachment) || busy) return;
    const img = attachment;
    setMessages((m) => [...m, { role: 'user', text: text || '📷 photo', image: img?.preview, ts: Date.now() }]);
    setInput('');
    setAttachment(null);
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name, text: text || undefined, imageBase64: img?.base64, imageMime: img?.mime }),
      });
      const json = (await res.json()) as { reply?: string; error?: string };
      setMessages((m) => [...m, { role: 'bot', text: json.reply ?? `⚠️ ${json.error ?? 'agent failed'}`, ts: Date.now() }]);
    } catch (err) {
      setMessages((m) => [...m, { role: 'bot', text: `⚠️ cannot reach the backend: ${(err as Error).message}`, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setAttachment({ base64: dataUrl.split(',')[1] ?? '', mime: file.type || 'image/jpeg', preview: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  if (!joined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-xl">
          <div className="mb-4 text-center">
            <div className="text-4xl">💬</div>
            <h1 className="mt-2 text-xl font-bold">Chat with SafeLink</h1>
            <p className="text-xs text-slate-500">The AI escrow agent — same brain as the WhatsApp bot</p>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your business name (e.g. Ada Thrift Store)"
            className="mb-3 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Your phone (e.g. 2348000000000)"
            className="mb-4 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm"
          />
          <button onClick={join} className="w-full rounded-xl bg-kolo-600 py-3 font-semibold text-white hover:bg-kolo-700">
            Start chatting
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex h-screen max-w-md flex-col border-slate-200 bg-[#e9e2d8] sm:border-x">
      {/* header */}
      <header className="flex items-center gap-3 bg-[#075e54] px-4 py-3 text-white">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-xl">🔒</div>
        <div className="flex-1">
          <p className="font-semibold">SafeLink · AI Escrow Agent</p>
          <p className="text-[11px] text-white/70">{name} · {phone}</p>
        </div>
        <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] uppercase tracking-wider">demo</span>
      </header>

      {/* messages */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
                m.role === 'user' ? 'rounded-br-sm bg-[#d9fdd3] text-slate-900' : 'rounded-bl-sm bg-white text-slate-900'
              }`}
            >
              {m.image && <img src={m.image} alt="attachment" className="mb-2 max-h-48 rounded-lg" />}
              <Linkify text={m.text} />
              <span className="mt-1 block text-right text-[10px] text-slate-400">
                {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-white px-4 py-3 text-sm shadow-sm">
              <span className="animate-bounce">●</span>
              <span className="animate-bounce [animation-delay:120ms]">●</span>
              <span className="animate-bounce [animation-delay:240ms]">●</span>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* suggestions */}
      {messages.length <= 1 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setInput(s)}
              className="rounded-full bg-white px-3 py-1.5 text-xs text-slate-600 shadow-sm hover:bg-slate-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* attachment preview */}
      {attachment && (
        <div className="flex items-center gap-2 bg-white px-3 py-2">
          <img src={attachment.preview} alt="preview" className="h-12 w-12 rounded-lg object-cover" />
          <span className="flex-1 text-xs text-slate-500">Photo ready — send it to verify a dispatch proof</span>
          <button onClick={() => setAttachment(null)} className="text-xs text-red-500">
            Remove
          </button>
        </div>
      )}

      {/* input bar */}
      <div className="flex items-center gap-2 bg-[#f0f0f0] p-2">
        <button onClick={() => fileRef.current?.click()} className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-slate-500 hover:bg-slate-200" title="Attach dispatch photo">
          📎
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          placeholder="Type a message…"
          className="flex-1 rounded-full bg-white px-4 py-2.5 text-sm outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={busy}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-[#075e54] text-white hover:bg-[#064c44] disabled:opacity-40"
        >
          ➤
        </button>
      </div>
    </main>
  );
}

/** Makes http(s) links clickable — checkout links must be tappable in the demo. */
function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="text-kolo-600 underline break-all">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
