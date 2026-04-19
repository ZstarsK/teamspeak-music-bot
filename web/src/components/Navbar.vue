<template>
  <nav class="navbar frosted-glass">
    <RouterLink to="/" class="logo">TSMusicBot</RouterLink>

    <div class="nav-links">
      <RouterLink to="/" class="nav-link" active-class="active">发现</RouterLink>
      <RouterLink to="/search" class="nav-link" active-class="active">搜索</RouterLink>
      <RouterLink to="/history" class="nav-link" active-class="active">播放历史</RouterLink>
    </div>

    <div class="nav-right">
      <!-- Bot selector (always shown when at least one bot exists) -->
      <div v-if="store.bots.length > 0" class="bot-selector" ref="selectorRef">
        <button class="bot-selector-btn" @click="dropdownOpen = !dropdownOpen">
          <span class="bot-dot" :class="{ online: activeBot?.connected }" />
          <span class="bot-selector-name">{{ activeBot?.name ?? '选择机器人' }}</span>
          <span v-if="activeBot?.playing && !activeBot?.paused" class="bot-state-mini playing">▶</span>
          <span v-else-if="activeBot?.paused" class="bot-state-mini paused">⏸</span>
          <Icon icon="mdi:chevron-down" class="bot-chevron" :class="{ rotated: dropdownOpen }" />
        </button>
        <div v-if="dropdownOpen" class="bot-dropdown">
          <div
            v-for="bot in store.bots"
            :key="bot.id"
            class="bot-dropdown-row"
          >
            <button
              class="bot-dropdown-item"
              :class="{ active: bot.id === store.activeBotId }"
              @click="selectBot(bot.id)"
            >
              <span class="bot-dot" :class="{ online: bot.connected }" />
              <span class="bot-dropdown-name">{{ bot.name }}</span>
              <span v-if="bot.playing && !bot.paused" class="bot-playing-badge">播放中</span>
              <span v-else-if="bot.paused" class="bot-paused-badge">已暂停</span>
              <span v-else-if="bot.connected" class="bot-idle-badge">空闲</span>
              <span v-else class="bot-offline-badge">离线</span>
            </button>
            <button
              class="bot-power-btn"
              :class="{ online: bot.connected }"
              :title="bot.connected ? `停止 ${bot.name}` : `启动 ${bot.name}`"
              :disabled="togglingBots[bot.id]"
              @click.stop="togglePower(bot)"
            >
              <Icon :icon="bot.connected ? 'mdi:power' : 'mdi:power-off'" />
            </button>
            <button class="bot-link-btn" :title="`复制 ${bot.name} 的专属链接`" @click.stop="copyBotLink(bot.id)">
              <Icon icon="mdi:link-variant" />
            </button>
          </div>
          <div class="bot-dropdown-divider" />
          <div class="bot-dropdown-hint">点击切换 · 🔗 复制专属链接</div>
        </div>
      </div>

      <RouterLink to="/settings" class="settings-btn">
        <Icon icon="mdi:cog" />
      </RouterLink>
    </div>
  </nav>

  <div v-if="linkDialog.open" class="link-dialog-backdrop" @click="closeLinkDialog">
    <div class="link-dialog" @click.stop>
      <div class="link-dialog-title">{{ linkDialog.name }} 的专属链接</div>
      <div class="link-dialog-hint">选中文本并按 Ctrl/Cmd+C 复制，或点击下方按钮</div>
      <input
        ref="linkInputRef"
        class="link-dialog-input"
        :value="linkDialog.url"
        readonly
        @focus="($event.target as HTMLInputElement).select()"
      />
      <div class="link-dialog-actions">
        <button class="link-dialog-btn primary" @click="copyLinkFromDialog">
          {{ linkDialog.copied ? '已复制' : '复制链接' }}
        </button>
        <button class="link-dialog-btn" @click="closeLinkDialog">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import { Icon } from '@iconify/vue';
import { usePlayerStore } from '../stores/player.js';
import { withBasePath } from '../lib/base.js';

const store = usePlayerStore();
const activeBot = computed(() => store.activeBot);
const dropdownOpen = ref(false);
const selectorRef = ref<HTMLElement | null>(null);
const togglingBots = ref<Record<string, boolean>>({});
const linkInputRef = ref<HTMLInputElement | null>(null);
const publicBaseUrl = ref<string | null>(null);

const linkDialog = reactive({
  open: false,
  url: '',
  name: '',
  copied: false,
});

function selectBot(id: string) {
  store.setActiveBotId(id);
  dropdownOpen.value = false;
}

function resolveBaseUrl(): string {
  const base = publicBaseUrl.value;
  if (base && /^https?:\/\//i.test(base)) return base.replace(/\/+$/, '');
  return window.location.origin;
}

async function tryClipboardWrite(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyBotLink(id: string) {
  const bot = store.bots.find((b) => b.id === id);
  const url = `${resolveBaseUrl()}${withBasePath(`/bot/${id}`)}`;
  linkDialog.url = url;
  linkDialog.name = bot?.name ?? '机器人';
  linkDialog.copied = false;
  linkDialog.open = true;
  dropdownOpen.value = false;
  // Try to copy silently; user can still manually select if it fails.
  const ok = await tryClipboardWrite(url);
  if (ok) linkDialog.copied = true;
  await nextTick();
  linkInputRef.value?.focus();
  linkInputRef.value?.select();
}

async function copyLinkFromDialog() {
  const ok = await tryClipboardWrite(linkDialog.url);
  if (ok) {
    linkDialog.copied = true;
  } else {
    linkInputRef.value?.focus();
    linkInputRef.value?.select();
  }
}

function closeLinkDialog() {
  linkDialog.open = false;
}

async function loadPublicBaseUrl() {
  try {
    const res = await fetch(withBasePath('/api/config/public-url'));
    if (!res.ok) return;
    const data = (await res.json()) as { publicUrl?: string | null };
    if (data.publicUrl) publicBaseUrl.value = data.publicUrl;
  } catch {
    // ignore — fall back to window.location.origin
  }
}

async function togglePower(bot: { id: string; connected: boolean; name: string }) {
  if (togglingBots.value[bot.id]) return;
  togglingBots.value[bot.id] = true;
  try {
    if (bot.connected) {
      await store.stopBotInstance(bot.id);
    } else {
      await store.startBotInstance(bot.id);
    }
  } catch (err) {
    console.error(`Failed to toggle bot ${bot.name}`, err);
  } finally {
    togglingBots.value[bot.id] = false;
  }
}

function onClickOutside(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    dropdownOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('click', onClickOutside);
  loadPublicBaseUrl();
});

onUnmounted(() => {
  document.removeEventListener('click', onClickOutside);
});
</script>

<style lang="scss" scoped>
.navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: var(--navbar-height);
  display: flex;
  align-items: center;
  padding: 0 10vw;
  z-index: 100;
  border-bottom: 1px solid var(--border-color);

  @media (max-width: 1336px) {
    padding: 0 5vw;
  }
}

.logo {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-primary);
  margin-right: 40px;
}

.nav-links {
  display: flex;
  gap: 24px;
}

.nav-link {
  font-size: 14px;
  font-weight: 600;
  opacity: 0.6;
  transition: opacity var(--transition-fast);

  &:hover { opacity: 0.8; }
  &.active { opacity: 1; color: var(--color-primary); }
}

.nav-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 16px;
}

.bot-status {
  padding: 4px 12px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  opacity: 0.6;

  &.online {
    background: rgba(51, 94, 234, 0.15);
    color: var(--color-primary);
    opacity: 1;
  }
}

/* Bot selector dropdown */
.bot-selector {
  position: relative;
}

.bot-selector-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 16px;
  font-weight: 600;
  min-height: 44px;
  border: 1px solid var(--border-color);
  transition: background var(--transition-fast), border-color var(--transition-fast);
  cursor: pointer;

  &:hover {
    background: var(--bg-card);
    border-color: var(--color-primary);
  }
}

.bot-state-mini {
  font-size: 14px;
  &.playing { color: #22c55e; }
  &.paused { color: #eab308; }
}

.bot-chevron {
  font-size: 20px;
  opacity: 0.5;
  transition: transform 0.2s ease;

  &.rotated {
    transform: rotate(180deg);
  }
}

.bot-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-tertiary);
  flex-shrink: 0;

  &.online {
    background: #22c55e;
  }
}

.bot-selector-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  z-index: 200;
}

.bot-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover {
    background: var(--hover-bg);
  }

  &.active {
    background: rgba(51, 94, 234, 0.12);
    color: var(--color-primary);
  }
}

.bot-dropdown-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.bot-dropdown-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-link-btn {
  flex-shrink: 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 15px;
  opacity: 0.4;
  transition: opacity var(--transition-fast), background var(--transition-fast);
  cursor: pointer;

  &:hover {
    opacity: 1;
    background: var(--hover-bg);
  }
}

.bot-power-btn {
  flex-shrink: 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 16px;
  opacity: 0.5;
  color: var(--text-tertiary);
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
  cursor: pointer;

  &:hover:not(:disabled) {
    opacity: 1;
    background: var(--hover-bg);
  }

  &:disabled {
    opacity: 0.25;
    cursor: wait;
  }

  &.online {
    color: #22c55e;
    opacity: 0.9;
  }
}

.bot-playing-badge,
.bot-paused-badge,
.bot-idle-badge,
.bot-offline-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
  flex-shrink: 0;
}

.bot-playing-badge {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.bot-paused-badge {
  background: rgba(234, 179, 8, 0.15);
  color: #eab308;
}

.bot-idle-badge {
  background: rgba(51, 94, 234, 0.12);
  color: var(--color-primary);
}

.bot-offline-badge {
  background: var(--hover-bg);
  color: var(--text-tertiary);
}

.bot-dropdown-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}

.bot-dropdown-hint {
  padding: 4px 12px 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: center;
}

.settings-btn {
  font-size: 22px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.link-dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.link-dialog {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 20px;
  min-width: 360px;
  max-width: 90vw;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.link-dialog-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}

.link-dialog-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 12px;
}

.link-dialog-input {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: inherit;
  user-select: all;
  -webkit-user-select: all;

  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
}

.link-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.link-dialog-btn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-color);
  background: var(--hover-bg);
  color: inherit;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);

  &:hover {
    background: var(--bg-card);
  }

  &.primary {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: #fff;

    &:hover {
      filter: brightness(1.08);
    }
  }
}
</style>
