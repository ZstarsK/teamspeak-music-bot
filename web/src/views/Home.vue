<template>
  <div class="home">
    <!-- Search Bar -->
    <div class="search-bar" @click="$router.push('/search')">
      <Icon icon="mdi:magnify" class="search-icon" />
      <span class="search-placeholder">搜索歌曲、歌单、专辑...</span>
    </div>

    <!-- Now Playing -->
    <section v-if="store.currentSong" class="section">
      <h2 class="section-title">正在播放</h2>
      <div class="now-playing">
        <CoverArt :url="store.currentSong.coverUrl" :size="80" :radius="10" :show-shadow="true" />
        <div class="now-playing-info">
          <div class="now-playing-name">{{ store.currentSong.name }}</div>
          <div class="now-playing-artist">{{ store.currentSong.artist }} · {{ store.currentSong.album }}</div>
        </div>
      </div>
    </section>

    <!-- 每日推荐 -->
    <section class="section" v-if="store.dailySongs.length > 0">
      <h2 class="section-title">每日推荐</h2>
      <div class="daily-grid">
        <div
          v-for="song in store.dailySongs.slice(0, 12)"
          :key="song.id"
          class="daily-card hover-scale"
          @click="store.playById(song.id, song.platform, song)"
        >
          <CoverArt :url="song.coverUrl" :size="120" :radius="10" :show-shadow="true" />
          <div class="daily-name">{{ song.name }}</div>
          <div class="daily-artist">{{ song.artist }}</div>
        </div>
      </div>
    </section>

    <!-- 推荐歌单 -->
    <section class="section" v-if="store.recommendPlaylists.length > 0">
      <h2 class="section-title">推荐歌单</h2>
      <div class="playlist-grid">
        <RouterLink
          v-for="playlist in store.recommendPlaylists"
          :key="playlist.id"
          :to="`/playlist/${playlist.id}?platform=${playlist.platform}`"
          class="playlist-card hover-scale"
        >
          <CoverArt :url="playlist.coverUrl" :size="160" :radius="10" :show-shadow="true" />
          <div class="playlist-name">{{ playlist.name }}</div>
        </RouterLink>
      </div>
    </section>

    <!-- 我的歌单 -->
    <section class="section" v-if="store.userPlaylists.length > 0">
      <h2 class="section-title">
        我的歌单
        <span class="section-count">{{ store.userPlaylists.length }}</span>
      </h2>
      <div class="account-playlist-groups">
        <div
          v-for="group in userPlaylistGroups"
          :key="group.id"
          class="account-playlist-group"
        >
          <div class="account-playlist-header">
            <div class="account-playlist-info">
              <img
                v-if="group.avatarUrl"
                :src="group.avatarUrl"
                class="account-avatar"
                alt=""
              />
              <div v-else class="account-avatar-placeholder">
                {{ platformLabel(group.platform).slice(0, 1) }}
              </div>
              <div class="account-heading">
                <div class="account-title">{{ group.title }}</div>
                <div class="account-subtitle">
                  {{ platformLabel(group.platform) }} · {{ group.total }} 个歌单
                </div>
              </div>
            </div>
            <button
              class="account-toggle-btn"
              :aria-expanded="group.expanded"
              @click="togglePlaylistGroup(group.id)"
            >
              <span>{{ group.expanded ? '收起' : '展开' }}</span>
              <Icon :icon="group.expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'" />
            </button>
          </div>

          <div v-if="group.expanded" class="playlist-grid">
            <RouterLink
              v-for="pl in group.playlists"
              :key="`${group.id}-${pl.id}`"
              :to="playlistRoute(pl)"
              class="playlist-card hover-scale"
            >
              <CoverArt :url="pl.coverUrl" :size="160" :radius="10" :show-shadow="true" />
              <div class="playlist-name">{{ pl.name }}</div>
              <div class="playlist-count">{{ pl.songCount }} 首</div>
            </RouterLink>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import { usePlayerStore, type PlaylistItem } from '../stores/player.js';
import CoverArt from '../components/CoverArt.vue';

const store = usePlayerStore();
const expandedPlaylistGroups = ref<Record<string, boolean>>({});

interface UserPlaylistGroup {
  id: string;
  title: string;
  platform: string;
  avatarUrl?: string;
  playlists: PlaylistItem[];
  total: number;
  expanded: boolean;
}

function platformLabel(platform: string) {
  if (platform === 'spotify') return 'Spotify';
  if (platform === 'qq') return 'QQ音乐';
  if (platform === 'bilibili') return 'B站';
  if (platform === 'youtube') return 'YouTube';
  return '网易云';
}

const userPlaylistGroups = computed<UserPlaylistGroup[]>(() => {
  const groups = new Map<string, Omit<UserPlaylistGroup, 'expanded' | 'total'>>();

  for (const playlist of store.userPlaylists) {
    const id = playlist.account?.id ?? playlist.platform;
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        title: playlist.account?.name ?? platformLabel(playlist.platform),
        platform: playlist.account?.platform ?? playlist.platform,
        avatarUrl: playlist.account?.avatarUrl,
        playlists: [],
      });
    }
    groups.get(id)!.playlists.push(playlist);
  }

  return Array.from(groups.values()).map((group) => {
    return {
      ...group,
      expanded: expandedPlaylistGroups.value[group.id] === true,
      total: group.playlists.length,
    };
  });
});

function togglePlaylistGroup(groupId: string) {
  expandedPlaylistGroups.value[groupId] = !expandedPlaylistGroups.value[groupId];
}

function playlistRoute(playlist: PlaylistItem) {
  const query: Record<string, string> = { platform: playlist.platform };
  if (playlist.account?.id) query.accountId = playlist.account.id;
  return { path: `/playlist/${playlist.id}`, query };
}

onMounted(() => {
  store.fetchHomeData();
});
</script>

<style lang="scss" scoped>
.search-bar {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-md);
  margin-bottom: 32px;
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
}

.search-icon {
  font-size: 20px;
  opacity: 0.4;
  margin-right: 12px;
}

.search-placeholder {
  opacity: 0.3;
  font-size: 14px;
}

.section {
  margin-bottom: 36px;
}

.section-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.account-playlist-groups {
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.account-playlist-group {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.account-playlist-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.account-playlist-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.account-heading {
  min-width: 0;
}

.account-avatar,
.account-avatar-placeholder {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  flex-shrink: 0;
}

.account-avatar {
  object-fit: cover;
}

.account-avatar-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 15px;
  font-weight: 700;
}

.account-title {
  font-size: 15px;
  font-weight: 700;
}

.account-subtitle {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.account-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  flex-shrink: 0;

  &:hover {
    background: var(--hover-bg);
    color: var(--color-primary);
  }
}

.bili-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: #00a1d6;
  color: white;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 800;
}

// Now Playing
.now-playing {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.now-playing-name {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 4px;
}

.now-playing-artist {
  font-size: 13px;
  color: var(--text-secondary);
}

// 私人FM
.fm-card {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 20px 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover {
    background: var(--hover-bg);
  }
}

.fm-icon-wrapper {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-primary), #6366f1);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.fm-icon {
  font-size: 28px;
  color: white;
}

.fm-info {
  flex: 1;
}

.fm-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.fm-desc {
  font-size: 13px;
  color: var(--text-secondary);
}

.fm-play-icon {
  font-size: 36px;
  color: var(--color-primary);
  opacity: 0.8;
  transition: opacity var(--transition-fast);

  .fm-card:hover & {
    opacity: 1;
  }
}

// 每日推荐
.daily-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 20px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.daily-card {
  cursor: pointer;
}

.daily-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.daily-artist {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// Playlists grid (shared for 推荐歌单 and 我的歌单)
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;

  @media (max-width: 1200px) { grid-template-columns: repeat(4, 1fr); }
  @media (max-width: 900px) { grid-template-columns: repeat(3, 1fr); }
}

.playlist-card {
  cursor: pointer;
  display: block;
  text-decoration: none;
  color: inherit;
}

.playlist-name {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.playlist-count {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 2px;
}
</style>
