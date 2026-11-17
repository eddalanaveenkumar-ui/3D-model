import { useState } from 'react';
import { LogOut, ShieldCheck, X } from 'lucide-react';
import type { UserProfile } from '@nv3d/shared';
import { api, ApiClientError } from '../../lib/api';

interface AuthModalProps {
  open: boolean;
  user: UserProfile | null;
  onClose: () => void;
  onUserChange: (user: UserProfile) => void;
}

export function AuthModal({ open, user, onClose, onUserChange }: AuthModalProps) {
  const [tab, setTab] = useState<'login' | 'register'>('register');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const isRegistered = user && !user.isGuest;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res =
        tab === 'register'
          ? await api.register({ email, password, displayName })
          : await api.login({ email, password });
      onUserChange(res.user);
      setEmail('');
      setPassword('');
      setDisplayName('');
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'Authentication failed. Please retry.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    setSubmitting(true);
    try {
      await api.logout();
      const fresh = await api.getMe();
      onUserChange(fresh.user);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[#262f42] bg-[#11151e] p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">
            {isRegistered ? 'Studio Account' : 'NV3D Studio Account'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close account modal"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8d97ab] transition hover:bg-[#1a212e] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isRegistered ? (
          <div className="mt-4 space-y-4">
            <div className="rounded-xl border border-[#222a3b] bg-[#151a25] p-4">
              <p className="text-sm font-semibold text-white">{user.displayName}</p>
              <p className="mt-0.5 text-xs text-[#8d97ab]">{user.email}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#222a3b] pt-3 text-xs">
                <div>
                  <span className="text-[#78839a]">Available Credits</span>
                  <p className="mt-0.5 font-mono-tech text-sm font-semibold text-[#a3e635]">
                    {user.credits} CR
                  </p>
                </div>
                <div>
                  <span className="text-[#78839a]">Saved Assets</span>
                  <p className="mt-0.5 font-mono-tech text-sm font-semibold text-white">
                    {user.totalGenerated}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-[#222a3b] bg-[#0e121a] px-3 py-2 text-[11px] text-[#8d97ab]">
              <ShieldCheck className="h-4 w-4 shrink-0 text-[#8ed90b]" />
              <span>Your uploaded reference images and generated GLB files are isolated to your account.</span>
            </div>

            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleLogout()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#2b3448] bg-[#171d29] px-4 py-2.5 text-xs font-medium text-[#d8deea] transition hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-xs text-[#8d97ab]">
              Create an account to keep your generated GLB models, reference uploads, and{' '}
              <span className="font-mono-tech text-[#cfd6e4]">{user?.credits ?? 250}</span> studio
              credits across sessions.
            </p>

            <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg border border-[#222a3b] bg-[#0d1017] p-1">
              <button
                type="button"
                onClick={() => {
                  setTab('register');
                  setError(null);
                }}
                className={`rounded-md py-1.5 text-xs font-medium transition ${
                  tab === 'register'
                    ? 'bg-[#1b2230] text-white'
                    : 'text-[#838ea4] hover:text-[#cfd6e4]'
                }`}
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => {
                  setTab('login');
                  setError(null);
                }}
                className={`rounded-md py-1.5 text-xs font-medium transition ${
                  tab === 'login'
                    ? 'bg-[#1b2230] text-white'
                    : 'text-[#838ea4] hover:text-[#cfd6e4]'
                }`}
              >
                Sign In
              </button>
            </div>

            <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 space-y-3">
              {tab === 'register' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#aeb7c9]">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Alex Mercer"
                    className="w-full rounded-lg border border-[#252e40] bg-[#0e1219] px-3 py-2 text-xs text-white placeholder-[#5a6478] focus:border-[#76b900] focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-[#aeb7c9]">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="artist@studio.com"
                  className="w-full rounded-lg border border-[#252e40] bg-[#0e1219] px-3 py-2 text-xs text-white placeholder-[#5a6478] focus:border-[#76b900] focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-[#aeb7c9]">Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  className="w-full rounded-lg border border-[#252e40] bg-[#0e1219] px-3 py-2 text-xs text-white placeholder-[#5a6478] focus:border-[#76b900] focus:outline-none"
                />
              </div>

              {error && (
                <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-[#76b900] px-4 py-2.5 text-xs font-semibold text-[#090d04] transition hover:bg-[#8ed90b] disabled:opacity-50"
              >
                {submitting
                  ? 'Authenticating...'
                  : tab === 'register'
                  ? 'Create Studio Account'
                  : 'Sign In to Workspace'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
