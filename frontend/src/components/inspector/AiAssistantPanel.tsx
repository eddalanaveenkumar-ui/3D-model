import { useState } from 'react';
import {
  AlertCircle,
  Check,
  Cpu,
  Loader2,
  Send,
  Settings,
  Wand2,
} from 'lucide-react';
import type {
  GenerationSettings,
  StructuredGenerationSpec,
  SystemStatus,
} from '@nv3d/shared';
import { api, ApiClientError } from '../../lib/api';

export interface ErrorDiagnosisState {
  source: 'nvidia-nim-minimax' | 'system-diagnostic';
  modelId: string | null;
  explanation: string;
  recommendedActions: string[];
}

interface ChatItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  modelId?: string;
}

interface AiAssistantPanelProps {
  systemStatus: SystemStatus | null;
  currentPrompt: string;
  settings: GenerationSettings;
  activeModelName: string | null;
  lastSpec: StructuredGenerationSpec | null;
  diagnosis: ErrorDiagnosisState | null;
  onApplySpec: (spec: StructuredGenerationSpec) => void;
  onOpenSettings: () => void;
}

export function AiAssistantPanel({
  systemStatus,
  currentPrompt,
  settings,
  activeModelName,
  lastSpec,
  diagnosis,
  onApplySpec,
  onOpenSettings,
}: AiAssistantPanelProps) {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localSpec, setLocalSpec] = useState<StructuredGenerationSpec | null>(null);
  const [applied, setApplied] = useState(false);

  const nimConfigured = systemStatus?.nim.configured ?? false;
  const modelId = systemStatus?.nim.modelId ?? 'minimaxai/minimax-m3.1-flash';
  const displayedSpec = localSpec ?? lastSpec;

  const handleSend = async (customText?: string) => {
    const text = (customText ?? input).trim();
    if (!text || busy) return;
    setError(null);
    setBusy(true);

    const userMsg: ChatItem = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!customText) setInput('');

    try {
      const res = await api.chatAssistant({
        message: text,
        history: messages.map((m) => ({ role: m.role, content: m.content })),
        context: {
          currentPrompt: currentPrompt || undefined,
          activeModelName: activeModelName || undefined,
          settings,
        },
      });
      setMessages([
        ...nextHistory,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: res.reply,
          modelId: res.modelId,
        },
      ]);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Failed to reach NVIDIA NIM assistant service.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleStructuredEnhance = async () => {
    if (!currentPrompt.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.enhancePrompt(currentPrompt, settings);
      setLocalSpec(res.spec);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Failed to execute MiniMax prompt structuring.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-3.5 text-xs">
        {/* NIM Engine Identity Card */}
        <div className="rounded-xl border border-[#222a3c] bg-[#0d1118] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold text-white">
              <Cpu className="h-3.5 w-3.5 text-[#8ed90b]" />
              MiniMax M3.1 Flash
            </span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                nimConfigured
                  ? 'border border-[#76b900]/40 bg-[#76b900]/14 text-[#a3e635]'
                  : 'border border-amber-500/35 bg-amber-500/10 text-amber-300'
              }`}
            >
              {nimConfigured ? 'NIM Ready' : 'Key Missing'}
            </span>
          </div>
          <p className="mt-1 font-mono-tech text-[10px] text-[#78839a]">{modelId}</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-[#9aa4b8]">
            Orchestrates prompt enhancement, multimodal reference analysis, structured JSON specs,
            and workflow diagnostics using your NVIDIA NIM API key.
          </p>
          {!nimConfigured && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="mt-2 flex items-center gap-1 text-[11px] font-medium text-amber-300 hover:underline"
            >
              <Settings className="h-3 w-3" />
              <span>Paste NVIDIA NIM API Key (saved in localStorage)</span>
            </button>
          )}
        </div>

        {/* Quick Action Buttons */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            disabled={busy || currentPrompt.trim().length < 3}
            onClick={() => void handleStructuredEnhance()}
            className="flex items-center gap-1 rounded-lg border border-[#263044] bg-[#151b27] px-2.5 py-1.5 text-[11px] font-medium text-[#d8deea] transition hover:border-[#76b900]/50 hover:text-white disabled:opacity-45"
          >
            <Wand2 className="h-3 w-3 text-[#8ed90b]" />
            <span>Structure Current Prompt</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void handleSend(
                'Recommend optimal polygon detail, texture resolution, and PBR prompt wording for my current 3D asset.'
              )
            }
            className="rounded-lg border border-[#263044] bg-[#151b27] px-2.5 py-1.5 text-[11px] font-medium text-[#d8deea] transition hover:border-[#3b4966] hover:text-white disabled:opacity-45"
          >
            Suggest PBR Settings
          </button>
        </div>

        {/* Error Diagnosis Card */}
        {diagnosis && (
          <div className="rounded-xl border border-sky-500/35 bg-sky-500/8 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-sky-300">Error Diagnosis</span>
              <span className="font-mono-tech text-[10px] text-[#838ea4]">
                {diagnosis.source === 'nvidia-nim-minimax' ? 'MiniMax' : 'Rulebook'}
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[#d8deea]">
              {diagnosis.explanation}
            </p>
            <ul className="mt-2 space-y-1 text-[11px] text-[#9aa4b8]">
              {diagnosis.recommendedActions.map((act, idx) => (
                <li key={idx} className="flex gap-1.5">
                  <span className="font-mono-tech text-[#8ed90b]">{idx + 1}.</span>
                  <span>{act}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Structured JSON Output Preview */}
        {displayedSpec && (
          <div className="rounded-xl border border-[#242e42] bg-[#0c1017] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-white">Structured JSON Output</span>
              <button
                type="button"
                onClick={() => {
                  onApplySpec(displayedSpec);
                  setApplied(true);
                  setTimeout(() => setApplied(false), 1600);
                }}
                className="flex items-center gap-1 rounded bg-[#76b900]/16 px-2 py-0.5 text-[10px] font-semibold text-[#a3e635] hover:bg-[#76b900]/25"
              >
                {applied ? <Check className="h-3 w-3" /> : null}
                <span>{applied ? 'Applied' : 'Apply to Prompt'}</span>
              </button>
            </div>
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-[#080a0f] p-2 font-mono-tech text-[10px] leading-relaxed text-[#9aa4b8]">
              {JSON.stringify(displayedSpec, null, 2)}
            </pre>
          </div>
        )}

        {/* Assistant Conversation */}
        {messages.length > 0 && (
          <div className="space-y-2">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-xl border p-2.5 text-[11px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'ml-4 border-[#283247] bg-[#171e2c] text-[#e6eaf2]'
                    : 'mr-2 border-[#76b900]/30 bg-[#10161e] text-[#d8deea]'
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Chat Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
        className="shrink-0 border-t border-[#1f2634] bg-[#0e1118] p-3"
      >
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              nimConfigured
                ? 'Ask MiniMax for prompt or 3D help...'
                : 'Configure NVIDIA_NIM_API_KEY to chat...'
            }
            className="min-w-0 flex-1 rounded-lg border border-[#242d40] bg-[#121722] px-3 py-2 text-xs text-white placeholder-[#5e687c] focus:border-[#76b900] focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send message to AI assistant"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#76b900] text-[#090d03] transition hover:bg-[#8ed90b] disabled:bg-[#242d3f] disabled:text-[#687389]"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      </form>
    </div>
  );
}
