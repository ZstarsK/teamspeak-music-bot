import { defineStore } from 'pinia';
import axios from 'axios';

export interface Song {
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'netease' | 'qq';
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: Song | null;
  queueSize: number;
  volume: number;
  playMode: string;
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    bots: [] as BotStatus[],
    activeBotId: null as string | null,
    queue: [] as Song[],
    theme: 'dark' as 'dark' | 'light',
    playStartedAt: 0, // timestamp when current song started
    pausedElapsed: 0, // elapsed time when paused
  }),

  getters: {
    activeBot(): BotStatus | null {
      return this.bots.find((b) => b.id === this.activeBotId) ?? this.bots[0] ?? null;
    },
    currentSong(): Song | null {
      return this.activeBot?.currentSong ?? null;
    },
    isPlaying(): boolean {
      return this.activeBot?.playing ?? false;
    },
    isPaused(): boolean {
      return this.activeBot?.paused ?? false;
    },
    /** Elapsed playback time in seconds */
    elapsed(): number {
      if (!this.activeBot?.currentSong) return 0;
      if (this.isPaused) return this.pausedElapsed;
      if (!this.isPlaying || this.playStartedAt === 0) return 0;
      return (Date.now() - this.playStartedAt) / 1000;
    },
  },

  actions: {
    setActiveBotId(id: string) {
      this.activeBotId = id;
    },

    updateBotStatus(botId: string, status: BotStatus) {
      const prev = this.bots.find((b) => b.id === botId);
      const prevSongId = prev?.currentSong?.id;
      const newSongId = status.currentSong?.id;

      const index = this.bots.findIndex((b) => b.id === botId);
      if (index >= 0) {
        this.bots[index] = status;
      } else {
        this.bots.push(status);
      }

      // Reset play timer when song changes
      if (newSongId && newSongId !== prevSongId) {
        this.playStartedAt = Date.now();
        this.pausedElapsed = 0;
      }

      // Track pause/resume
      if (status.playing && !status.paused && prev?.paused) {
        // Resumed — adjust start time
        this.playStartedAt = Date.now() - this.pausedElapsed * 1000;
      }
      if (status.paused && !prev?.paused) {
        // Paused — save elapsed
        this.pausedElapsed = this.playStartedAt > 0
          ? (Date.now() - this.playStartedAt) / 1000
          : 0;
      }
    },

    removeBotStatus(botId: string) {
      this.bots = this.bots.filter((b) => b.id !== botId);
    },

    setQueue(queue: Song[]) {
      this.queue = queue;
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', this.theme);
    },

    loadTheme() {
      const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
      if (saved) this.theme = saved;
    },

    async fetchBots() {
      const res = await axios.get('/api/bot');
      this.bots = res.data.bots;
      if (!this.activeBotId && this.bots.length > 0) {
        this.activeBotId = this.bots[0].id;
      }
      // If a song is playing, set the start time
      const bot = this.activeBot;
      if (bot?.playing && bot.currentSong && this.playStartedAt === 0) {
        this.playStartedAt = Date.now();
      }
    },

    async fetchQueue() {
      if (!this.activeBotId) return;
      try {
        const res = await axios.get(`/api/player/${this.activeBotId}/queue`);
        this.queue = res.data.queue ?? [];
      } catch {
        // ignore
      }
    },

    async play(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/play`, { query, platform });
      this.playStartedAt = Date.now();
      this.pausedElapsed = 0;
    },

    async addToQueue(query: string, platform = 'netease') {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/add`, { query, platform });
    },

    async pause() {
      if (!this.activeBotId) return;
      this.pausedElapsed = this.playStartedAt > 0
        ? (Date.now() - this.playStartedAt) / 1000
        : 0;
      await axios.post(`/api/player/${this.activeBotId}/pause`);
    },

    async resume() {
      if (!this.activeBotId) return;
      this.playStartedAt = Date.now() - this.pausedElapsed * 1000;
      await axios.post(`/api/player/${this.activeBotId}/resume`);
    },

    async next() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/next`);
      this.playStartedAt = Date.now();
      this.pausedElapsed = 0;
    },

    async prev() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/prev`);
      this.playStartedAt = Date.now();
      this.pausedElapsed = 0;
    },

    async stop() {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/stop`);
      this.playStartedAt = 0;
      this.pausedElapsed = 0;
    },

    async setVolume(volume: number) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/volume`, { volume });
    },

    async setMode(mode: string) {
      if (!this.activeBotId) return;
      await axios.post(`/api/player/${this.activeBotId}/mode`, { mode });
    },
  },
});
