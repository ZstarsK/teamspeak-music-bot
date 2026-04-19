<template>
  <div class="search-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      返回
    </button>
    <div class="search-header">
      <div class="search-input-wrap">
        <Icon icon="mdi:magnify" class="search-icon" />
        <input
          ref="searchInput"
          v-model="query"
          class="search-input"
          placeholder="搜索歌曲、歌手、专辑..."
          @keyup.enter="onSearchEnter"
          autofocus
        />
      </div>
      <div class="platform-tabs">
        <button
          v-for="platform in platforms"
          :key="platform.value"
          class="platform-tab"
          :class="{ active: activePlatform === platform.value }"
          @click="switchPlatform(platform.value)"
        >
          {{ platform.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading">搜索{{ platformLabel(activePlatform) }}中...</div>

    <div v-else-if="activeResults.length > 0" class="results">
      <SongCard
        v-for="(song, i) in activeResults"
        :key="`${song.platform}-${song.id}`"
        :song="song"
        :index="i + 1"
        :active="store.currentSong?.id === song.id"
        @play="store.playById(song.id, song.platform, song)"
        @add="store.addToQueueById(song.id, song.platform, song)"
      />
    </div>

    <div v-else-if="searchedPlatforms[activePlatform]" class="empty">
      {{ platformLabel(activePlatform) }}未找到相关结果
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore } from '../stores/player.js';
import SongCard from '../components/SongCard.vue';

const store = usePlayerStore();
const route = useRoute();

type SearchPlatform = 'spotify' | 'qq' | 'netease' | 'bilibili';

const platforms = [
  { value: 'spotify', label: 'Spotify' },
  { value: 'qq', label: 'QQ音乐' },
  { value: 'netease', label: '网易云' },
  { value: 'bilibili', label: 'B站' },
] satisfies Array<{ value: SearchPlatform; label: string }>;

const query = ref((route.query.q as string) || '');
const activePlatform = ref<SearchPlatform>('spotify');
const resultsByPlatform = reactive<Record<SearchPlatform, Array<{
  id: string;
  name: string;
  artist: string;
  album: string;
  duration: number;
  coverUrl: string;
  platform: 'netease' | 'qq' | 'bilibili' | 'youtube' | 'spotify';
  mediaId?: string;
  accountId?: string;
}>>>({
  netease: [],
  qq: [],
  bilibili: [],
  spotify: [],
});
const searchedPlatforms = reactive<Record<SearchPlatform, boolean>>({
  netease: false,
  qq: false,
  bilibili: false,
  spotify: false,
});
const loading = ref(false);
const lastSearchedQuery = ref('');

const activeResults = computed(() => resultsByPlatform[activePlatform.value]);

function platformLabel(platform: SearchPlatform) {
  return platforms.find((item) => item.value === platform)?.label ?? platform;
}

async function doSearch(platform: SearchPlatform = activePlatform.value) {
  if (!query.value.trim()) return;
  if (query.value !== lastSearchedQuery.value) {
    for (const item of platforms) {
      resultsByPlatform[item.value] = [];
      searchedPlatforms[item.value] = false;
    }
    lastSearchedQuery.value = query.value;
  }
  loading.value = true;
  searchedPlatforms[platform] = true;
  try {
    const res = await axios.get('/api/music/search', {
      params: { q: query.value, platform },
    });
    resultsByPlatform[platform] = res.data.songs ?? [];
  } catch {
    resultsByPlatform[platform] = [];
  } finally {
    loading.value = false;
  }
}

function onSearchEnter() {
  void doSearch();
}

async function switchPlatform(platform: SearchPlatform) {
  activePlatform.value = platform;
  if (query.value.trim() && !searchedPlatforms[platform]) {
    await doSearch(platform);
  }
}

onMounted(() => {
  const routePlatform = route.query.platform as SearchPlatform | undefined;
  if (routePlatform && platforms.some((item) => item.value === routePlatform)) {
    activePlatform.value = routePlatform;
  }
  if (query.value) doSearch(activePlatform.value);
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.search-header {
  margin-bottom: 24px;
}

.platform-tabs {
  display: flex;
  gap: 8px;
}

.search-input-wrap {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.search-icon {
  font-size: 22px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-input {
  flex: 1;
  border: none;
  background: none;
  outline: none;
  font-size: 16px;
  font-family: inherit;
  color: var(--text-primary);

  &::placeholder {
    color: var(--text-tertiary);
  }
}

.platform-tab {
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  transition: all var(--transition-fast);

  &:hover {
    color: var(--text-primary);
  }

  &.active {
    background: var(--color-primary);
    color: white;
  }
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}

.empty {
  text-align: center;
  padding: 60px;
  color: var(--text-tertiary);
  font-size: 14px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
