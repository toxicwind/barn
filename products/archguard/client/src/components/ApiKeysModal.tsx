import React, { useState } from 'react';
import { X, Key, Check } from 'lucide-react';

interface ApiKeysModalProps {
  isOpen: boolean;
  onClose: () => void;
  runtimeKey: string;
  runtimeProvider: 'openrouter' | 'gemini';
  onSave: (key: string, provider: 'openrouter' | 'gemini') => void;
}

export const ApiKeysModal: React.FC<ApiKeysModalProps> = ({
  isOpen,
  onClose,
  runtimeKey,
  runtimeProvider,
  onSave,
}) => {
  const [key, setKey] = useState(runtimeKey);
  const [provider, setProvider] = useState<'openrouter' | 'gemini'>(runtimeProvider);

  if (!isOpen) return null;

  const handleApply = () => {
    onSave(key.trim(), provider);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-md bg-[#0a0a0a] border border-white/[0.12] rounded-2xl p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
              <Key className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Runtime LLM Configuration</h3>
              <p className="text-[11px] text-neutral-400 font-mono">
                Optional custom API key injected via runtime headers
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] uppercase font-mono text-neutral-400 block">LLM Provider</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setProvider('openrouter')}
                className={`p-2.5 rounded-lg border text-xs font-mono transition-all text-left ${
                  provider === 'openrouter'
                    ? 'border-amber-500/80 bg-amber-950/20 text-amber-300 font-bold'
                    : 'border-white/[0.08] bg-[#050505] text-neutral-400 hover:text-white'
                }`}
              >
                OpenRouter (Default)
              </button>
              <button
                type="button"
                onClick={() => setProvider('gemini')}
                className={`p-2.5 rounded-lg border text-xs font-mono transition-all text-left ${
                  provider === 'gemini'
                    ? 'border-cyan-500/80 bg-cyan-950/20 text-cyan-300 font-bold'
                    : 'border-white/[0.08] bg-[#050505] text-neutral-400 hover:text-white'
                }`}
              >
                Google Gemini
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] uppercase font-mono text-neutral-400 block">
              API Key (Optional override)
            </label>
            <input
              type="password"
              placeholder="sk-or-v1-... or AIzaSy..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full bg-[#050505] text-xs font-mono text-white p-2.5 rounded-lg border border-white/[0.08] focus:outline-none focus:border-cyan-500/50"
            />
            <p className="text-[10px] text-neutral-500 font-mono mt-1">
              If left blank, the backend automatically uses configured server `.env` keys.
            </p>
          </div>
        </div>

        <div className="flex justify-end space-x-2 pt-2 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-mono rounded-lg border border-white/[0.08] text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black flex items-center space-x-1.5 transition-all shadow-[0_0_15px_rgba(6,182,212,0.3)]"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
