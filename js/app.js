/* Loop — vanilla JavaScript + Supabase. No framework or build step required. */
(() => {
  'use strict';

  const CONFIG = window.LOOP_CONFIG || {};
  const hasConfig = CONFIG.SUPABASE_URL && CONFIG.SUPABASE_PUBLIC_KEY &&
    !CONFIG.SUPABASE_URL.includes('PASTE_') && !CONFIG.SUPABASE_PUBLIC_KEY.includes('PASTE_');
  const view = document.getElementById('view');
  const userNav = document.getElementById('user-nav');
  const toastStack = document.getElementById('toast-stack');
  const confirmDialog = document.getElementById('confirm-dialog');
  const confirmAccept = document.getElementById('confirm-accept');
  let db = null;
  let currentUser = null;
  let myProfile = null;
  let realtimeChannels = [];
  let activeVideoView = null;
  let photoViewTimer = null;
  let photoViewPostId = null;
  let renderToken = 0;
  let pendingConfirmAction = null;
  let activeChatPeer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const initials = (name = 'L') => esc((String(name).trim().charAt(0) || 'L').toUpperCase());
  const timeAgo = value => {
    const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(value).toLocaleDateString();
  };
  const formatTime = seconds => {
    if (!Number.isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };
  const publicUrl = (bucket, path) => path ? db.storage.from(bucket).getPublicUrl(path).data.publicUrl : '';
  const avatarHtml = (profile, css = 'avatar') => {
    const url = profile?.avatar_path ? publicUrl('loop-avatars', profile.avatar_path) : '';
    return url
      ? `<img class="${css}" src="${esc(url)}" alt="${esc(profile.display_name || profile.username || 'User')}" loading="lazy">`
      : `<span class="${css} avatar-fallback">${initials(profile?.display_name || profile?.username || 'L')}</span>`;
  };
  const authorLink = profile => `#/profile/${encodeURIComponent(profile?.username || '')}`;
  const setActiveNav = () => {
    const hash = location.hash || '#/feed';
    $$('.nav-link').forEach(link => link.classList.toggle('active', hash.startsWith(link.getAttribute('href'))));
  };
  const toast = (message, type = 'info') => {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastStack.append(el);
    const hide = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 240); };
    const timer = setTimeout(hide, 4200);
    document.addEventListener('pointerdown', event => {
      if (!el.contains(event.target)) { clearTimeout(timer); hide(); }
    }, {once:true});
  };
  const showLoading = message => {
    view.innerHTML = `<section class="loading-state"><div class="loader"></div><p>${esc(message || 'Opening Loop…')}</p></section>`;
  };
  const showError = (message, retry = true) => {
    view.innerHTML = `<section class="empty-state"><div class="symbol">!</div><h2>That didn't load</h2><p>${esc(message)}</p>${retry ? '<button class="button button-primary" data-action="reload">Try again</button>' : '<a class="button button-primary" href="#/feed">Back to For You</a>'}</section>`;
  };
  const handleError = (error, fallback = 'Something went wrong. Please try again.') => {
    console.error(error);
    toast(error?.message || fallback, 'error');
  };

  if (!hasConfig) {
    renderSetupScreen();
    return;
  }
  if (!window.supabase?.createClient) {
    showError('The Supabase JavaScript library could not load. Check your internet connection and refresh.', false);
    return;
  }
  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLIC_KEY, {
    auth: {persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}
  });

  function renderSetupScreen() {
    userNav.innerHTML = '';
    view.innerHTML = `
      <section class="auth-shell">
        <span class="eyebrow">WELCOME TO LOOP</span>
        <h1>Your quieter social space.</h1>
        <p>The interface is ready. Connect your free Supabase project to enable real accounts, uploads, posts, notifications and messages.</p>
        <div class="settings-note"><b>One-time setup:</b><br>1. Create a Supabase project.<br>2. Run <code>supabase/schema.sql</code> in its SQL Editor.<br>3. Paste the Project URL and publishable/anon key into <code>js/config.js</code>.<br>4. Push this folder to GitHub and enable Pages.</div>
        <p><a class="button button-dark button-full" href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Open Supabase dashboard ↗</a></p>
      </section>`;
  }

  async function refreshUser() {
    const {data, error} = await db.auth.getUser();
    if (error && error.message !== 'Auth session missing!') console.warn(error.message);
    currentUser = data?.user || null;
    myProfile = null;
    if (currentUser) {
      const {data: profile, error: profileError} = await db.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
      if (profileError) console.warn(profileError.message);
      myProfile = profile;
    }
    updateUserNav();
    await updateBadges();
    setupRealtime();
  }

  function updateUserNav() {
    if (!currentUser) {
      userNav.innerHTML = '<a class="button button-dark button-small" href="#/login">Sign in</a>';
      return;
    }
    const avatar = myProfile?.avatar_path ? publicUrl('loop-avatars', myProfile.avatar_path) : '';
    userNav.innerHTML = `
      <a class="button button-primary button-small" href="#/upload">＋ Create</a>
      <a href="#/profile/${encodeURIComponent(myProfile?.username || '')}" aria-label="Your profile">${avatar ? `<img class="mini-avatar" src="${esc(avatar)}" alt="">` : `<span class="mini-avatar avatar-fallback">${initials(myProfile?.display_name)}</span>`}</a>
      <button class="quiet-button" data-action="signout">Sign out</button>`;
  }

  async function updateBadges() {
    const notificationBadge = $('#notification-count');
    const messageBadge = $('#message-count');
    if (!currentUser) {
      notificationBadge?.classList.add('hidden');
      messageBadge?.classList.add('hidden');
      return;
    }
    const [notifs, messages] = await Promise.all([
      db.from('notifications').select('id', {count:'exact', head:true}).eq('recipient_id', currentUser.id).eq('is_read', false).neq('type', 'message'),
      db.from('messages').select('id', {count:'exact', head:true}).eq('recipient_id', currentUser.id).is('read_at', null)
    ]);
    setBadge(notificationBadge, notifs.count || 0);
    setBadge(messageBadge, messages.count || 0);
  }
  function setBadge(element, count) {
    if (!element) return;
    element.textContent = count > 99 ? '99+' : String(count);
    element.classList.toggle('hidden', !count);
  }

  function setupRealtime() {
    realtimeChannels.forEach(channel => db.removeChannel(channel));
    realtimeChannels = [];
    if (!currentUser) return;
    const noticeChannel = db.channel(`loop-notifications-${currentUser.id}`)
      .on('postgres_changes', {event:'INSERT', schema:'public', table:'notifications', filter:`recipient_id=eq.${currentUser.id}`}, payload => {
        updateBadges();
        if (payload.new.type !== 'message') toast('Someone interacted with your post.', 'success');
      }).subscribe();
    const messageChannel = db.channel(`loop-messages-${currentUser.id}`)
      .on('postgres_changes', {event:'INSERT', schema:'public', table:'messages', filter:`recipient_id=eq.${currentUser.id}`}, payload => {
        // New messages are represented by the unread Inbox badge, not a toast or notification.
        updateBadges();
        if (activeChatPeer === payload.new.sender_id) renderChat(activeChatPeer, false);
      }).subscribe();
    realtimeChannels.push(noticeChannel, messageChannel);
  }

  function requireAuth() {
    if (currentUser) return true;
    toast('Sign in to use that feature.', 'info');
    location.hash = '#/login';
    return false;
  }

  function renderMedia(post, detail = false) {
    const src = publicUrl('loop-posts', post.media_path);
    if (post.media_type === 'video') {
      return `<div class="loop-player" data-player data-post-id="${esc(post.id)}">
        <video class="loop-video" preload="metadata" playsinline webkit-playsinline disablepictureinpicture src="${esc(src)}"></video>
        <button class="player-center-play" data-player-play aria-label="Play video">▶</button>
        <div class="player-controls">
          <button class="player-icon-button" data-player-toggle aria-label="Play or pause">▶</button>
          <span class="player-time" data-current>0:00</span>
          <input class="player-progress" data-progress type="range" min="0" max="1000" value="0" aria-label="Video progress">
          <span class="player-time" data-duration>0:00</span>
          <button class="player-icon-button player-mute" data-mute aria-label="Mute">◖))</button>
          <button class="player-icon-button" data-fullscreen aria-label="Fullscreen">⛶</button>
        </div>
      </div>`;
    }
    const image = `<img src="${esc(src)}" alt="${esc(post.caption || 'Loop photo')}" loading="lazy">`;
    return detail ? image : `<a href="#/post/${encodeURIComponent(post.id)}" aria-label="Open post">${image}</a>`;
  }

  function renderPostCard(post, savedIds = new Set(), detail = false) {
    const author = post.author || {};
    const isOwn = currentUser && post.user_id === currentUser.id;
    const saved = savedIds.has(post.id);
    const location = [post.location_city, post.location_region].filter(Boolean).join(', ');
    const tags = (post.tags || []).map(tag => `<span>#${esc(tag)}</span>`).join('');
    return `<article class="post-card" data-post-card="${esc(post.id)}">
      <div class="post-topline">
        <a class="post-author" href="${authorLink(author)}">
          ${avatarHtml(author)}
          <span class="author-meta"><b>${esc(author.display_name || author.username || 'Loop user')}</b><small>@${esc(author.username || 'user')}${location ? ` · ${esc(location)}` : ''}</small></span>
        </a>
        <div class="post-tools">
          <span class="post-kind">${post.media_type === 'video' ? 'VIDEO' : 'PHOTO'}</span>
          ${isOwn ? '<button class="post-menu" data-action="delete-post" data-id="'+esc(post.id)+'">Delete</button>' : ''}
        </div>
      </div>
      <div class="media-stage ${detail ? 'detail-stage' : ''}">${renderMedia(post, detail)}</div>
      <div class="post-content">
        ${post.caption ? `<p class="post-caption">${esc(post.caption)}</p>` : ''}
        ${tags ? `<div class="tag-row">${tags}</div>` : ''}
        <div class="post-actions">
          <button class="action-button bookmark-action ${saved ? 'saved' : ''}" data-action="bookmark" data-id="${esc(post.id)}"><span>${saved ? '◆' : '◇'}</span><small>${saved ? 'Saved' : 'Save'}</small></button>
          <a class="action-button" href="#/post/${encodeURIComponent(post.id)}"><span>⌁</span><small>${post.comments_count || 0} comments</small></a>
          <span class="view-count">◉ ${Number(post.views_count || 0).toLocaleString()} views</span>
          <a class="open-post-link" href="#/post/${encodeURIComponent(post.id)}">View post ↗</a>
          <time class="post-date">${timeAgo(post.created_at)}</time>
        </div>
      </div>
    </article>`;
  }

  async function loadSavedIds() {
    if (!currentUser) return new Set();
    const {data, error} = await db.from('bookmarks').select('post_id').eq('user_id', currentUser.id);
    if (error) throw error;
    return new Set((data || []).map(row => row.post_id));
  }

  // Rank recent posts using location and the viewer's past activity, then
  // re-order the ranked list to avoid showing the same topic repeatedly.
  async function getFeedPosts() {
    const {data, error} = await db.from('posts')
      .select('*, author:profiles!posts_user_id_fkey(id, username, display_name, bio, avatar_path, city, region)')
      .order('created_at', {ascending:false}).limit(120);
    if (error) throw error;
    const posts = data || [];
    if (!currentUser || !posts.length) return posts;

    const [bookmarks, comments, views] = await Promise.all([
      db.from('bookmarks').select('post_id,created_at').eq('user_id', currentUser.id).order('created_at',{ascending:false}).limit(300),
      db.from('comments').select('post_id,created_at').eq('user_id', currentUser.id).order('created_at',{ascending:false}).limit(300),
      db.from('post_views').select('post_id,created_at').eq('viewer_id', currentUser.id).order('created_at',{ascending:false}).limit(400)
    ]);
    for (const result of [bookmarks, comments, views]) {
      if (result.error) throw result.error;
    }

    const bookmarkIds = new Set((bookmarks.data || []).map(row => row.post_id));
    const commentIds = new Set((comments.data || []).map(row => row.post_id));
    const viewIds = new Set((views.data || []).map(row => row.post_id));
    const engagementWeights = new Map();
    const addWeight = (id, amount) => engagementWeights.set(id, (engagementWeights.get(id) || 0) + amount);
    (bookmarks.data || []).forEach(row => addWeight(row.post_id, 5));
    (comments.data || []).forEach(row => addWeight(row.post_id, 4));
    (views.data || []).forEach(row => addWeight(row.post_id, 1));

    const engagedIds = [...engagementWeights.keys()].slice(0, 300);
    const interestCounts = new Map();
    if (engagedIds.length) {
      const {data: engagedPosts, error: interestError} = await db.from('posts')
        .select('id,tags').in('id', engagedIds);
      if (interestError) throw interestError;
      (engagedPosts || []).forEach(post => {
        const weight = engagementWeights.get(post.id) || 1;
        (post.tags || []).forEach(rawTag => {
          const tag = String(rawTag).trim().toLowerCase().replace(/^#/, '');
          if (tag) interestCounts.set(tag, (interestCounts.get(tag) || 0) + weight);
        });
      });
    }

    const city = String(myProfile?.city || '').toLowerCase().trim();
    const region = String(myProfile?.region || '').toLowerCase().trim();
    const now = Date.now();
    const scored = posts.map(post => {
      const ageHours = Math.max(0, (now - new Date(post.created_at).getTime()) / 3600000);
      const tags = [...new Set((post.tags || []).map(rawTag => String(rawTag).trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
      const tagScores = tags.map(tag => ({tag, score: Math.min(8, Math.log2(1 + (interestCounts.get(tag) || 0)) * 2.7)}))
        .sort((a,b) => b.score - a.score);
      const interestScore = Math.min(18, tagScores.slice(0, 3).reduce((sum, item) => sum + item.score, 0));
      const cityMatch = city && String(post.location_city || '').toLowerCase().trim() === city;
      const regionMatch = region && String(post.location_region || '').toLowerCase().trim() === region;
      // A smooth 36-hour decay keeps new posts visible without immediately
      // burying older posts that strongly match someone's interests.
      const freshnessScore = 24 * Math.exp(-ageHours / 36);
      const locationScore = (cityMatch ? 13 : 0) + (!cityMatch && regionMatch ? 7 : 0);
      const repeatPenalty = (viewIds.has(post.id) ? 4 : 0) + (bookmarkIds.has(post.id) ? 3 : 0) + (commentIds.has(post.id) ? 1.5 : 0);
      const explorationBonus = interestCounts.size && tags.length && !tagScores.some(item => item.score > 0) ? 2 : 0;
      const score = freshnessScore + locationScore + interestScore + explorationBonus - repeatPenalty;
      const primaryTag = tagScores[0]?.tag || tags[0] || '__untagged__';
      return {...post, _loopScore:score, _loopTopic:primaryTag};
    });

    return diversifyFeed(scored);
  }

  function diversifyFeed(scoredPosts) {
    const remaining = scoredPosts.slice();
    const ranked = [];
    const recentTopics = [];
    const recentAuthors = [];

    while (remaining.length) {
      let bestIndex = 0;
      let bestAdjusted = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const post = remaining[i];
        const topic = post._loopTopic || '__untagged__';
        const authorId = post.user_id || '';
        let diversityPenalty = 0;
        if (recentTopics[0] === topic) diversityPenalty += 15;
        else if (recentTopics.slice(0, 3).includes(topic)) diversityPenalty += 7;
        if (recentAuthors.slice(0, 2).includes(authorId)) diversityPenalty += 4;
        const adjusted = (post._loopScore || 0) - diversityPenalty;
        if (adjusted > bestAdjusted || (adjusted === bestAdjusted && new Date(post.created_at) > new Date(remaining[bestIndex].created_at))) {
          bestAdjusted = adjusted;
          bestIndex = i;
        }
      }
      const [chosen] = remaining.splice(bestIndex, 1);
      ranked.push(chosen);
      recentTopics.unshift(chosen._loopTopic || '__untagged__');
      recentAuthors.unshift(chosen.user_id || '');
      recentTopics.length = Math.min(recentTopics.length, 4);
      recentAuthors.length = Math.min(recentAuthors.length, 3);
    }
    return ranked;
  }

  async function renderFeed() {
    showLoading('Finding your corner of Loop…');
    const token = ++renderToken;
    try {
      const [posts, savedIds] = await Promise.all([getFeedPosts(), loadSavedIds()]);
      if (token !== renderToken) return;
      const intro = `<section class="feed-intro"><span class="eyebrow">A LITTLE LESS NOISE</span><h1>Find your<br><em>loop.</em></h1><p>A calmer feed shaped by what you watch, save and talk about — plus the places and topics that matter to you.</p>${currentUser ? '<div class="feed-tip"><span class="tip-icon">✳</span><span><b>Your feed learns as you explore.</b><small>No likes. No popularity contest.</small></span></div>' : '<div class="feed-tip"><span class="tip-icon">✳</span><span><b>Sign in to personalize your feed.</b><small>Your city and activity shape recommendations.</small></span></div>'}</section>`;
      const feed = posts.length ? posts.map(post => renderPostCard(post, savedIds)).join('') : emptyState('✳', 'A fresh start.', 'There are no posts yet. Be the first to share a moment.', currentUser ? '<a class="button button-primary" href="#/upload">Create your first post</a>' : '<a class="button button-primary" href="#/register">Join Loop</a>');
      let side = '';
      if (currentUser && myProfile) side = `<aside class="feed-side"><div class="side-card"><span class="eyebrow">YOUR SPACE</span><div class="side-profile-row">${avatarHtml(myProfile,'side-avatar')}<span><b>${esc(myProfile.display_name)}</b><small>@${esc(myProfile.username)}</small></span></div><p class="side-bio">${esc(myProfile.bio || 'Your little corner of Loop.')}</p><a class="text-link" href="${authorLink(myProfile)}">View profile →</a></div><div class="side-note"><span class="eyebrow">A LOOP NOTE</span><b>Less scrolling.<br>More meaning.</b><p>Save the things you want to return to. Talk like a human. Keep it kind.</p></div></aside>`;
      view.innerHTML = `<div class="feed-layout">${intro}<section class="feed-column">${feed}</section>${side}</div>`;
      bindPlayers(view);
    } catch (error) { showError(error.message || 'Could not load the feed.'); }
  }

  function emptyState(symbol, heading, message, action = '') {
    return `<section class="empty-state"><div class="symbol">${symbol}</div><h2>${esc(heading)}</h2><p>${esc(message)}</p>${action}</section>`;
  }

  async function renderSaved() {
    if (!requireAuth()) return;
    showLoading('Opening your saved posts…');
    try {
      const {data: saved, error} = await db.from('bookmarks').select('post_id, created_at').eq('user_id', currentUser.id).order('created_at',{ascending:false});
      if (error) throw error;
      const ids = (saved || []).map(row => row.post_id);
      let posts = [];
      if (ids.length) {
        const result = await db.from('posts').select('*, author:profiles!posts_user_id_fkey(id, username, display_name, bio, avatar_path, city, region)').in('id', ids);
        if (result.error) throw result.error;
        const map = new Map((result.data || []).map(post => [post.id, post]));
        posts = ids.map(id => map.get(id)).filter(Boolean);
      }
      const savedIds = new Set(ids);
      view.innerHTML = `<section class="social-page"><header class="page-heading"><span class="eyebrow">YOUR COLLECTION</span><h1>Saved <em>moments.</em></h1><p>Posts you chose to keep close.</p></header>${posts.length ? posts.map(post => renderPostCard(post, savedIds)).join('') : emptyState('◇','Nothing saved yet.','Bookmark a photo or video and it will live here.','<a class="button button-primary" href="#/feed">Explore the feed</a>')}</section>`;
      bindPlayers(view);
    } catch (error) { showError(error.message); }
  }

  async function renderPostPage(postId) {
    showLoading('Opening post…');
    if (photoViewTimer) clearTimeout(photoViewTimer);
    activeVideoView = null;
    try {
      const {data: post, error} = await db.from('posts').select('*, author:profiles!posts_user_id_fkey(id, username, display_name, bio, avatar_path, city, region)').eq('id', postId).maybeSingle();
      if (error) throw error;
      if (!post) { showError('This post may have been deleted.', false); return; }
      const [savedIds, commentsResult] = await Promise.all([
        loadSavedIds(),
        db.from('comments').select('*, author:profiles!comments_user_id_fkey(id, username, display_name, avatar_path)').eq('post_id', postId).order('created_at',{ascending:true})
      ]);
      if (commentsResult.error) throw commentsResult.error;
      const comments = commentsResult.data || [];
      const commentRows = comments.length ? comments.map(comment => `<div class="comment-item">${avatarHtml(comment.author,'avatar')}<div class="comment-copy"><b>${esc(comment.author?.display_name || comment.author?.username || 'Loop user')}</b><p>${esc(comment.body)}</p><time>${timeAgo(comment.created_at)}</time></div></div>`).join('') : '<p class="form-help">No comments yet. Start a thoughtful conversation.</p>';
      const commentForm = currentUser ? `<form id="comment-form" class="comment-form"><textarea id="comment-body" maxlength="1200" placeholder="Write a comment… (up to 100 words)" required></textarea><div class="comment-form-bottom"><small id="comment-word-count">0 / 100 words</small><button class="button button-primary button-small" type="submit">Post comment</button></div></form>` : '<p class="form-help"><a href="#/login">Sign in</a> to join the conversation.</p>';
      view.innerHTML = `<section class="single-post-page"><a class="back-link" href="#/feed">← Back to For You</a>${renderPostCard(post,savedIds,true)}<section class="detail-comments"><h2>Conversation <span class="form-help">(${comments.length})</span></h2><div id="comment-list" class="comment-list">${commentRows}</div>${commentForm}</section></section>`;
      bindPlayers(view);
      setupDetailViewTracking(post);
    } catch (error) { showError(error.message); }
  }

  function setupDetailViewTracking(post) {
    activeVideoView = null;
    if (!currentUser || post.user_id === currentUser.id) return;
    if (post.media_type === 'image') {
      photoViewPostId = post.id;
      armPhotoViewTimer();
    } else {
      photoViewPostId = null;
      activeVideoView = {postId:post.id, watched:0, lastTime:null, recorded:false};
    }
  }

  function armPhotoViewTimer() {
    if (photoViewTimer) clearTimeout(photoViewTimer);
    if (!photoViewPostId || document.visibilityState !== 'visible') return;
    const postId = photoViewPostId;
    photoViewTimer = setTimeout(() => {
      photoViewTimer = null;
      if (document.visibilityState === 'visible' && location.hash === `#/post/${postId}`) {
        photoViewPostId = null;
        recordView(postId);
      }
    }, 3000);
  }

  async function recordView(postId) {
    if (!currentUser) return;
    const {data, error} = await db.from('post_views').upsert({post_id:postId, viewer_id:currentUser.id}, {onConflict:'post_id,viewer_id', ignoreDuplicates:true}).select('post_id');
    if (error) console.warn('View count was not recorded:', error.message);
    else if (data?.length) {
      const card = $(`[data-post-card="${postId}"]`);
      if (card) {
        const count = $('.view-count', card);
        if (count) {
          const n = Number(count.textContent.replace(/[^0-9]/g,'')) || 0;
          count.textContent = `◉ ${(n + 1).toLocaleString()} views`;
        }
      }
    }
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function syncFullscreenPlayerUi() {
    const activeElement = getFullscreenElement();
    const players = $$('[data-player]');
    let fallbackOpen = false;
    players.forEach(player => {
      const active = activeElement === player || player.classList.contains('is-fallback-fullscreen');
      player.classList.toggle('is-fullscreen', active);
      if (player.classList.contains('is-fallback-fullscreen')) fallbackOpen = true;
      const button = $('[data-fullscreen]', player);
      if (button) {
        button.textContent = active ? '⤡' : '⛶';
        button.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
        button.title = active ? 'Exit fullscreen' : 'Enter fullscreen';
      }
    });
    document.body.classList.toggle('loop-fallback-fullscreen-open', fallbackOpen);
  }

  async function togglePlayerFullscreen(player) {
    const activeElement = getFullscreenElement();
    const isNativeFullscreen = activeElement === player;
    const isFallbackFullscreen = player.classList.contains('is-fallback-fullscreen');

    if (isNativeFullscreen) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      try {
        if (exit) await exit.call(document);
        else player.classList.remove('is-fallback-fullscreen');
      } catch (error) {
        // If the browser's fullscreen API rejects the exit request, retain a
        // visible in-page exit control instead of trapping the viewer.
        player.classList.remove('is-fallback-fullscreen');
      }
      syncFullscreenPlayerUi();
      return;
    }

    if (isFallbackFullscreen) {
      player.classList.remove('is-fallback-fullscreen');
      syncFullscreenPlayerUi();
      return;
    }

    const request = player.requestFullscreen || player.webkitRequestFullscreen || player.mozRequestFullScreen || player.msRequestFullscreen;
    if (request) {
      try {
        await request.call(player);
      } catch (error) {
        // A CSS fullscreen fallback still provides a working, reversible
        // fullscreen toggle on browsers that deny the Fullscreen API.
        player.classList.add('is-fallback-fullscreen');
      }
    } else {
      player.classList.add('is-fallback-fullscreen');
    }
    syncFullscreenPlayerUi();
  }

  let fullscreenListenersBound = false;
  function ensureFullscreenListeners() {
    if (fullscreenListenersBound) return;
    fullscreenListenersBound = true;
    ['fullscreenchange','webkitfullscreenchange','mozfullscreenchange','MSFullscreenChange'].forEach(eventName => {
      document.addEventListener(eventName, syncFullscreenPlayerUi);
    });
  }

  function bindPlayers(root) {
    ensureFullscreenListeners();
    $$('[data-player]', root).forEach(player => {
      if (player.dataset.bound === '1') return;
      player.dataset.bound = '1';
      const video = $('video', player);
      const playButtons = $$('[data-player-play],[data-player-toggle]', player);
      const progress = $('[data-progress]', player);
      const current = $('[data-current]', player);
      const duration = $('[data-duration]', player);
      const updatePlayState = () => {
        player.classList.toggle('is-playing', !video.paused);
        playButtons.forEach(button => button.textContent = video.paused ? '▶' : 'Ⅱ');
      };
      const toggle = () => video.paused ? video.play().catch(() => toast('This video could not start playing.', 'error')) : video.pause();
      playButtons.forEach(button => button.addEventListener('click', toggle));
      video.addEventListener('click', toggle);
      video.addEventListener('play', () => {
        updatePlayState();
        if (activeVideoView?.postId === player.dataset.postId) activeVideoView.lastTime = video.currentTime;
      });
      video.addEventListener('pause', () => {
        updatePlayState();
        if (activeVideoView?.postId === player.dataset.postId) activeVideoView.lastTime = null;
      });
      video.addEventListener('loadedmetadata', () => { if (duration) duration.textContent = formatTime(video.duration); });
      video.addEventListener('timeupdate', () => {
        if (current) current.textContent = formatTime(video.currentTime);
        if (progress && Number.isFinite(video.duration) && video.duration > 0) progress.value = String(Math.round(video.currentTime / video.duration * 1000));
        const tracker = activeVideoView;
        if (tracker && tracker.postId === player.dataset.postId && !tracker.recorded && !video.paused && !video.seeking) {
          if (tracker.lastTime !== null) {
            const delta = video.currentTime - tracker.lastTime;
            if (delta > 0 && delta <= 1.2) tracker.watched += delta;
          }
          tracker.lastTime = video.currentTime;
          const required = Math.min(6, Number.isFinite(video.duration) ? video.duration : 6);
          if (tracker.watched >= required) {
            tracker.recorded = true;
            recordView(tracker.postId);
          }
        }
      });
      video.addEventListener('seeking', () => { if (activeVideoView?.postId === player.dataset.postId) activeVideoView.lastTime = null; });
      video.addEventListener('seeked', () => { if (activeVideoView?.postId === player.dataset.postId) activeVideoView.lastTime = video.currentTime; });
      progress?.addEventListener('input', () => { if (Number.isFinite(video.duration)) video.currentTime = Number(progress.value) / 1000 * video.duration; });
      $('[data-mute]', player)?.addEventListener('click', event => { video.muted = !video.muted; event.currentTarget.textContent = video.muted ? '×' : '◖))'; });
      $('[data-fullscreen]', player)?.addEventListener('click', () => togglePlayerFullscreen(player));
    });
    syncFullscreenPlayerUi();
  }

  async function renderNotifications() {
    if (!requireAuth()) return;
    showLoading('Checking in…');
    try {
      const {data, error} = await db.from('notifications')
        .select('*, actor:profiles!notifications_actor_id_fkey(id, username, display_name, avatar_path)')
        .eq('recipient_id', currentUser.id).neq('type', 'message').order('created_at',{ascending:false}).limit(100);
      if (error) throw error;
      const notifications = data || [];
      const items = notifications.length ? notifications.map(n => {
        const actor = n.actor || {};
        const href = n.type === 'message' ? `#/dm/${actor.id}` : n.post_id ? `#/post/${n.post_id}` : authorLink(actor);
        const label = n.type === 'comment' ? 'commented on your post' : n.type === 'bookmark' ? 'saved your post' : 'sent you a message';
        return `<a class="notification-item ${n.is_read ? '' : 'unread'}" href="${href}" data-notification="${n.id}"><span class="notification-avatar">${avatarHtml(actor,'notification-avatar-inner')}</span><span class="notification-copy"><b>${esc(actor.display_name || actor.username || 'Someone')}</b> ${label}<small>@${esc(actor.username || 'loopuser')}</small><time>${timeAgo(n.created_at)}</time></span><span class="notification-type">${n.type === 'comment' ? '⌁' : n.type === 'bookmark' ? '◇' : '✉'}</span></a>`;
      }).join('') : emptyState('♧','All quiet here.','When someone comments on or saves one of your posts, you will see it here. New messages stay in your Inbox.');
      view.innerHTML = `<section class="social-page"><header class="page-heading"><span class="eyebrow">LITTLE MOMENTS OF CONNECTION</span><h1>Your <em>notifications.</em></h1><p>Only meaningful interactions. No alerts for every view.</p>${notifications.some(n => !n.is_read) ? '<button class="quiet-button" data-action="mark-all-read">Mark all as read</button>' : ''}</header><div class="notification-list">${items}</div></section>`;
    } catch (error) { showError(error.message); }
  }

  async function renderMessages() {
    if (!requireAuth()) return;
    showLoading('Opening your inbox…');
    try {
      const {data, error} = await db.from('messages').select('id,sender_id,recipient_id,body,read_at,created_at').order('created_at',{ascending:false}).limit(500);
      if (error) throw error;
      const latestByPeer = new Map();
      (data || []).forEach(message => {
        const peerId = message.sender_id === currentUser.id ? message.recipient_id : message.sender_id;
        if (!latestByPeer.has(peerId)) latestByPeer.set(peerId, message);
      });
      const peers = [...latestByPeer.keys()];
      let profiles = [];
      if (peers.length) {
        const result = await db.from('profiles').select('id,username,display_name,avatar_path').in('id',peers);
        if (result.error) throw result.error;
        profiles = result.data || [];
      }
      const profileMap = new Map(profiles.map(p => [p.id,p]));
      const unreadByPeer = new Map();
      (data || []).forEach(m => { if (m.recipient_id === currentUser.id && !m.read_at) unreadByPeer.set(m.sender_id,(unreadByPeer.get(m.sender_id)||0)+1); });
      const rows = peers.map(peerId => {
        const profile = profileMap.get(peerId) || {id:peerId,username:'user',display_name:'Loop user'};
        const last = latestByPeer.get(peerId);
        const unread = unreadByPeer.get(peerId) || 0;
        return `<a class="conversation-item" href="#/dm/${peerId}">${avatarHtml(profile,'notification-avatar')}<span class="conversation-copy"><b>${esc(profile.display_name)}</b><small>${esc(last.body)}</small><small>@${esc(profile.username)} · ${timeAgo(last.created_at)}</small></span>${unread ? `<span class="conversation-unread">${unread}</span>` : ''}</a>`;
      }).join('');
      view.innerHTML = `<section class="social-page"><header class="page-heading"><span class="eyebrow">PRIVATE CONVERSATIONS</span><h1>Your <em>inbox.</em></h1><p>Messages stay between you and the person you're talking to.</p><a class="button button-outline button-small" href="#/discover">Find people to message</a></header><div class="conversation-list">${rows || emptyState('✉','Your inbox is empty.','Visit a profile and start a conversation.','<a class="button button-primary" href="#/discover">Find people</a>')}</div></section>`;
    } catch (error) { showError(error.message); }
  }

  async function renderChat(peerId, showLoader = true) {
    if (!requireAuth()) return;
    if (peerId === currentUser.id) { toast('You cannot message yourself.'); location.hash = '#/messages'; return; }
    if (showLoader) showLoading('Opening conversation…');
    activeChatPeer = peerId;
    try {
      const [peerResult, messagesResult] = await Promise.all([
        db.from('profiles').select('id,username,display_name,avatar_path').eq('id',peerId).maybeSingle(),
        db.from('messages').select('*').or(`and(sender_id.eq.${currentUser.id},recipient_id.eq.${peerId}),and(sender_id.eq.${peerId},recipient_id.eq.${currentUser.id})`).order('created_at',{ascending:true}).limit(500)
      ]);
      if (peerResult.error) throw peerResult.error;
      if (messagesResult.error) throw messagesResult.error;
      const peer = peerResult.data;
      if (!peer) { showError('This profile could not be found.', false); return; }
      const unreadIds = (messagesResult.data || []).filter(m => m.recipient_id === currentUser.id && !m.read_at).map(m => m.id);
      if (unreadIds.length) {
        await db.from('messages').update({read_at:new Date().toISOString()}).in('id',unreadIds);
        updateBadges();
      }
      const bubbles = (messagesResult.data || []).map(message => {
        const mine = message.sender_id === currentUser.id;
        return `<div class="chat-bubble-row ${mine ? 'mine' : 'theirs'}"><div class="chat-bubble">${esc(message.body)}<time>${new Date(message.created_at).toLocaleString([], {hour:'numeric',minute:'2-digit',month:'short',day:'numeric'})}</time></div></div>`;
      }).join('');
      view.innerHTML = `<section class="chat-page"><header class="chat-heading"><a class="back-link" href="#/messages">← Inbox</a><a class="chat-person" href="${authorLink(peer)}">${avatarHtml(peer,'avatar')}<span><b>${esc(peer.display_name)}</b><small>@${esc(peer.username)}</small></span></a></header><div id="chat-messages" class="chat-messages">${bubbles || '<div class="chat-empty">Say hello and start the conversation.</div>'}</div><form id="chat-form" class="chat-compose"><textarea id="message-body" maxlength="2000" placeholder="Write a message…" required></textarea><button class="button button-primary" type="submit">Send ↗</button></form></section>`;
      const container = $('#chat-messages');
      container.scrollTop = container.scrollHeight;
    } catch (error) { showError(error.message); }
  }

  async function renderProfile(username) {
    showLoading('Opening profile…');
    try {
      const {data: profile, error} = await db.from('profiles').select('*').eq('username',username).maybeSingle();
      if (error) throw error;
      if (!profile) { showError('That profile could not be found.', false); return; }
      const own = currentUser && profile.id === currentUser.id;
      const [postsResult, savedIds] = await Promise.all([
        db.from('posts').select('id,media_path,media_type,caption,views_count,created_at').eq('user_id',profile.id).order('created_at',{ascending:false}).limit(100),
        own ? loadSavedIds() : Promise.resolve(new Set())
      ]);
      if (postsResult.error) throw postsResult.error;
      const posts = postsResult.data || [];
      const location = [profile.city,profile.region].filter(Boolean).join(', ');
      const avatar = profile.avatar_path ? publicUrl('loop-avatars',profile.avatar_path) : '';
      const grid = posts.map(post => `<a class="profile-grid-item" href="#/post/${post.id}">${post.media_type === 'video' ? `<video src="${esc(publicUrl('loop-posts',post.media_path))}" muted preload="metadata"></video><span>▶</span>` : `<img src="${esc(publicUrl('loop-posts',post.media_path))}" alt="" loading="lazy">`}<span>◉ ${Number(post.views_count||0).toLocaleString()}</span></a>`).join('');
      view.innerHTML = `<section><header class="profile-hero">${avatar ? `<img class="profile-avatar" src="${esc(avatar)}" alt="">` : `<span class="profile-avatar avatar-fallback">${initials(profile.display_name)}</span>`}<div class="profile-info"><h1>${esc(profile.display_name)}</h1><span class="handle">@${esc(profile.username)}</span><p>${esc(profile.bio || 'A little corner of Loop.')}</p><div class="profile-meta"><span>${posts.length} posts</span>${location ? `<span>⌖ ${esc(location)}</span>` : ''}</div><div class="profile-actions">${own ? '<button class="button button-primary button-small" data-action="edit-profile">Edit profile</button>' : currentUser ? `<a class="button button-dark button-small" href="#/dm/${profile.id}">Message ↗</a>` : '<a class="button button-dark button-small" href="#/login">Sign in to message</a>'}</div></div></header><div class="profile-grid">${grid || emptyState('✳',own ? 'Your story starts here.' : 'No posts yet.','When this person shares something, it will appear here.',own ? '<a class="button button-primary" href="#/upload">Create a post</a>' : '')}</div></section>`;
    } catch (error) { showError(error.message); }
  }

  async function renderEditProfile() {
    if (!requireAuth()) return;
    if (!myProfile) { await refreshUser(); }
    const avatar = myProfile?.avatar_path ? publicUrl('loop-avatars',myProfile.avatar_path) : '';
    view.innerHTML = `<section class="auth-shell"><span class="eyebrow">YOUR CORNER OF LOOP</span><h1>Edit profile.</h1><p>Keep it simple. You can change these details anytime.</p><form id="profile-form" class="form-stack"><div class="field"><label>Profile picture</label>${avatar ? `<img src="${esc(avatar)}" class="profile-avatar" alt="Current profile picture">` : ''}<label class="file-pick">Choose photo<input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp"></label><small>JPG, PNG or WebP · up to 4 MB</small></div><div class="field"><label for="profile-display">Display name</label><input id="profile-display" maxlength="40" required value="${esc(myProfile?.display_name || '')}"></div><div class="field"><label for="profile-username">Username</label><input id="profile-username" value="${esc(myProfile?.username || '')}" disabled><small>Username changes are not enabled in this starter release.</small></div><div class="field"><label for="profile-bio">Bio</label><textarea id="profile-bio" maxlength="160">${esc(myProfile?.bio || '')}</textarea></div><div class="form-row"><div class="field"><label for="profile-city">City</label><input id="profile-city" maxlength="60" value="${esc(myProfile?.city || '')}" placeholder="e.g. Kathmandu"></div><div class="field"><label for="profile-region">Region / province</label><input id="profile-region" maxlength="60" value="${esc(myProfile?.region || '')}" placeholder="e.g. Bagmati"></div></div><small class="form-help">Location is entered manually. Loop does not collect precise GPS location.</small><button class="button button-primary button-full" type="submit">Save profile</button></form></section>`;
  }

  async function renderUpload() {
    if (!requireAuth()) return;
    view.innerHTML = `<section class="upload-card"><header class="page-heading"><span class="eyebrow">SHARE A MOMENT</span><h1>Create a <em>post.</em></h1><p>Photos up to 10 MB. Videos up to 50 MB and 60 seconds.</p></header><form id="upload-form" class="form-stack"><div class="field"><label>Choose a photo or video</label><div id="upload-preview" class="upload-preview"><div class="placeholder"><span>＋</span>Choose media to preview it here</div></div><label class="file-pick">Choose photo or video<input id="post-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/x-m4v" required></label><small id="file-help">Images: JPG, PNG, WebP or GIF · Videos: MP4, MOV or M4V · maximum 60 seconds</small></div><div class="field"><label for="post-caption">Caption</label><textarea id="post-caption" maxlength="500" placeholder="What would you like to share? (500 characters max)"></textarea></div><div class="form-row"><div class="field"><label for="post-city">City</label><input id="post-city" maxlength="60" value="${esc(myProfile?.city || '')}" placeholder="City"></div><div class="field"><label for="post-region">Region / province</label><input id="post-region" maxlength="60" value="${esc(myProfile?.region || '')}" placeholder="Region"></div></div><small class="form-help">These optional location labels help people nearby discover relevant posts.</small><button class="button button-primary button-full" type="submit">Share with Loop ↗</button></form></section>`;
    $('#post-file')?.addEventListener('change', previewUpload);
  }

  let validatedUpload = null;
  async function previewUpload(event) {
    const file = event.target.files?.[0];
    validatedUpload = null;
    const preview = $('#upload-preview');
    const help = $('#file-help');
    if (!file) return;
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) { toast('Choose a supported photo or video.', 'error'); event.target.value=''; return; }
    if (isImage && file.size > 10 * 1024 * 1024) { toast('Photos must be 10 MB or smaller.', 'error'); event.target.value=''; return; }
    if (isVideo && file.size > 50 * 1024 * 1024) { toast('Videos must be 50 MB or smaller.', 'error'); event.target.value=''; return; }
    const url = URL.createObjectURL(file);
    if (isImage) {
      preview.innerHTML = `<img src="${esc(url)}" alt="Selected photo">`;
      validatedUpload = {file, type:'image', duration:null, url};
      help.textContent = `${file.name} · ${(file.size/1048576).toFixed(1)} MB`;
      return;
    }
    preview.innerHTML = `<video src="${esc(url)}" controls muted playsinline></video>`;
    help.textContent = `Checking video duration… ${file.name}`;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = () => {
      if (!Number.isFinite(probe.duration) || probe.duration > 60) {
        toast('Videos must be 60 seconds or shorter.', 'error');
        event.target.value = '';
        preview.innerHTML = '<div class="placeholder"><span>＋</span>Choose media to preview it here</div>';
        help.textContent = 'Videos must be 60 seconds or shorter.';
        URL.revokeObjectURL(url);
        return;
      }
      validatedUpload = {file, type:'video', duration:probe.duration, url};
      help.textContent = `${file.name} · ${(file.size/1048576).toFixed(1)} MB · ${probe.duration.toFixed(1)} seconds`;
    };
    probe.onerror = () => { toast('The video could not be read. Try MP4 or MOV.', 'error'); event.target.value=''; };
  }

  async function validateComment(text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error('Write a comment first.');
    if (words.length > 100) throw new Error('Comments are limited to 100 words.');
    const blocked = ['fuck','shit','bitch','asshole','bastard','motherfucker','cunt','dickhead','slut','whore','nigger','faggot'];
    const found = words.some(word => blocked.some(term => new RegExp(`^${term}[.,!?]*$`, 'i').test(word)));
    if (found) throw new Error('Please remove vulgar or abusive language before posting.');
    return words.length;
  }

  async function toggleBookmark(postId, button) {
    if (!requireAuth()) return;
    const existing = button.classList.contains('saved');
    const result = existing
      ? await db.from('bookmarks').delete().eq('user_id',currentUser.id).eq('post_id',postId)
      : await db.from('bookmarks').insert({user_id:currentUser.id,post_id:postId});
    if (result.error) { handleError(result.error); return; }
    button.classList.toggle('saved',!existing);
    const icon = $('span',button), label = $('small',button);
    if (icon) icon.textContent = existing ? '◇' : '◆';
    if (label) label.textContent = existing ? 'Save' : 'Saved';
    toast(existing ? 'Removed from Saved.' : 'Added to Saved.', 'success');
  }

  function confirmAction(title, message, label, action) {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    confirmAccept.textContent = label;
    pendingConfirmAction = action;
    confirmDialog.showModal();
  }

  async function deletePost(postId) {
    try {
      const {data: post, error} = await db.from('posts').select('media_path,user_id').eq('id',postId).maybeSingle();
      if (error) throw error;
      if (!post || post.user_id !== currentUser.id) throw new Error('You can only delete your own posts.');
      const storageResult = await db.storage.from('loop-posts').remove([post.media_path]);
      if (storageResult.error) console.warn('Media cleanup warning:',storageResult.error.message);
      const result = await db.from('posts').delete().eq('id',postId).eq('user_id',currentUser.id);
      if (result.error) throw result.error;
      toast('Your post was deleted.', 'success');
      if (location.hash.startsWith(`#/post/${postId}`)) location.hash = '#/feed';
      else render();
    } catch (error) { handleError(error); }
  }

  async function uploadPost() {
    if (!validatedUpload) throw new Error('Choose a valid photo or video first.');
    const {file,type,duration} = validatedUpload;
    const ext = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'') || (type==='image'?'jpg':'mp4');
    const safeName = `${crypto.randomUUID()}.${ext}`;
    const path = `${currentUser.id}/${safeName}`;
    const {error:uploadError} = await db.storage.from('loop-posts').upload(path,file,{cacheControl:'31536000',upsert:false,contentType:file.type});
    if (uploadError) throw uploadError;
    const caption = $('#post-caption').value.trim();
    const tags = [...new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(tag => tag.slice(1).toLowerCase()))].slice(0,12);
    const row = {
      user_id:currentUser.id, caption, media_path:path, media_type:type,
      duration_seconds:duration ? Number(duration.toFixed(2)) : null,
      tags, location_city:$('#post-city').value.trim(), location_region:$('#post-region').value.trim()
    };
    const {error:insertError} = await db.from('posts').insert(row);
    if (insertError) {
      await db.storage.from('loop-posts').remove([path]);
      throw insertError;
    }
    toast('Your post is now on Loop.', 'success');
    validatedUpload = null;
    location.hash = '#/feed';
  }

  async function sendComment(postId) {
    const body = $('#comment-body')?.value.trim() || '';
    await validateComment(body);
    const {error} = await db.from('comments').insert({post_id:postId,user_id:currentUser.id,body});
    if (error) throw error;
    toast('Comment posted.', 'success');
    await renderPostPage(postId);
  }

  async function saveProfile() {
    const display_name = $('#profile-display').value.trim();
    const bio = $('#profile-bio').value.trim();
    const city = $('#profile-city').value.trim();
    const region = $('#profile-region').value.trim();
    if (!display_name) throw new Error('Add a display name.');
    const patch = {display_name,bio,city,region};
    const file = $('#avatar-file').files?.[0];
    if (file) {
      if (!file.type.startsWith('image/') || file.size > 4*1024*1024) throw new Error('Profile photos must be an image up to 4 MB.');
      const ext = file.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'') || 'jpg';
      const path = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const {error:uploadError} = await db.storage.from('loop-avatars').upload(path,file,{upsert:false,contentType:file.type});
      if (uploadError) throw uploadError;
      const oldPath = myProfile?.avatar_path;
      patch.avatar_path = path;
      const {error:updateError} = await db.from('profiles').update(patch).eq('id',currentUser.id);
      if (updateError) { await db.storage.from('loop-avatars').remove([path]); throw updateError; }
      if (oldPath) await db.storage.from('loop-avatars').remove([oldPath]);
    } else {
      const {error} = await db.from('profiles').update(patch).eq('id',currentUser.id);
      if (error) throw error;
    }
    await refreshUser();
    toast('Profile updated.', 'success');
    location.hash = `#/profile/${encodeURIComponent(myProfile.username)}`;
  }

  async function sendMessage(peerId) {
    const body = $('#message-body')?.value.trim() || '';
    if (!body) return;
    if (body.length > 2000) throw new Error('Messages are limited to 2,000 characters.');
    const {error} = await db.from('messages').insert({sender_id:currentUser.id,recipient_id:peerId,body});
    if (error) throw error;
    await renderChat(peerId,false);
  }

  async function searchUsers(term) {
    const results = $('#user-search-results');
    if (!results) return;
    if (term.trim().length < 2) { results.innerHTML = '<p class="form-help">Type at least two characters to search.</p>'; return; }
    const cleanTerm = term.replace(/[^a-zA-Z0-9_. -]/g, '').trim();
    if (cleanTerm.length < 2) { results.innerHTML = '<p class="form-help">Type at least two characters to search.</p>'; return; }
    const [byUsername, byName] = await Promise.all([
      db.from('profiles').select('id,username,display_name,bio,avatar_path,city,region').ilike('username', `%${cleanTerm}%`).limit(20),
      db.from('profiles').select('id,username,display_name,bio,avatar_path,city,region').ilike('display_name', `%${cleanTerm}%`).limit(20)
    ]);
    const error = byUsername.error || byName.error;
    if (error) { results.innerHTML = `<p class="form-help">${esc(error.message)}</p>`; return; }
    const data = [...(byUsername.data || []), ...(byName.data || [])];
    const unique = new Map(data.map(profile => [profile.id,profile]));
    const filtered = [...unique.values()].filter(profile => profile.id !== currentUser?.id);
    results.innerHTML = filtered.length ? filtered.map(profile => `<a class="conversation-item" href="${authorLink(profile)}">${avatarHtml(profile,'notification-avatar')}<span class="conversation-copy"><b>${esc(profile.display_name)}</b><small>@${esc(profile.username)} · ${esc([profile.city,profile.region].filter(Boolean).join(', '))}</small></span><span class="text-link">View →</span></a>`).join('') : '<p class="form-help">No users found.</p>';
  }

  async function renderDiscover() {
    if (!requireAuth()) return;
    view.innerHTML = `<section class="social-page"><header class="page-heading"><span class="eyebrow">FIND YOUR PEOPLE</span><h1>Discover <em>Loop.</em></h1><p>Search by username or display name. Open a profile to start a conversation.</p></header><div class="field"><label for="user-search">Search people</label><input id="user-search" placeholder="Try a username or name…" autocomplete="off"></div><div id="user-search-results" class="conversation-list" style="margin-top:16px"><p class="form-help">Type at least two characters to search.</p></div></section>`;
    $('#user-search').addEventListener('input', event => searchUsers(event.target.value));
  }

  async function markNotification(id) {
    const {error} = await db.from('notifications').update({is_read:true}).eq('id',id).eq('recipient_id',currentUser.id);
    if (error) console.warn(error.message);
    updateBadges();
  }

  async function markAllNotificationsRead() {
    const {error} = await db.from('notifications').update({is_read:true}).eq('recipient_id',currentUser.id).eq('is_read',false);
    if (error) throw error;
    toast('All caught up.', 'success');
    renderNotifications();
    updateBadges();
  }

  async function renderAuth(mode) {
    const isRegister = mode === 'register';
    view.innerHTML = `<section class="auth-shell"><span class="eyebrow">${isRegister ? 'MAKE YOURSELF AT HOME' : 'WELCOME BACK'}</span><h1>${isRegister ? 'Join the loop.' : 'Good to see you.'}</h1><p>${isRegister ? 'A quieter corner of the internet starts with you.' : 'Sign in to find your feed, saved posts and conversations.'}</p><form id="auth-form" class="form-stack">${isRegister ? '<div class="field"><label for="auth-name">Display name</label><input id="auth-name" maxlength="40" required placeholder="Your name"></div><div class="field"><label for="auth-username">Username</label><input id="auth-username" minlength="3" maxlength="24" pattern="[A-Za-z0-9_.]+" required placeholder="yourname"><small>3–24 letters, numbers, underscores or dots.</small></div>' : ''}<div class="field"><label for="auth-email">Email</label><input id="auth-email" type="email" autocomplete="email" required placeholder="you@example.com"></div><div class="field"><label for="auth-password">Password</label><input id="auth-password" type="password" minlength="8" autocomplete="${isRegister?'new-password':'current-password'}" required placeholder="At least 8 characters"></div><button class="button button-primary button-full" type="submit">${isRegister ? 'Create account' : 'Sign in'} ↗</button></form><p class="auth-switch">${isRegister ? 'Already have an account?' : 'New to Loop?'} <a href="#/${isRegister?'login':'register'}">${isRegister?'Sign in':'Create an account'}</a></p></section>`;
  }

  async function submitAuth(mode) {
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (mode === 'register') {
      const username = $('#auth-username').value.trim().toLowerCase();
      const display_name = $('#auth-name').value.trim();
      if (!/^[a-z0-9_.]{3,24}$/.test(username)) throw new Error('Username must be 3–24 letters, numbers, underscores or dots.');
      const {data,error} = await db.auth.signUp({email,password,options:{data:{username,display_name},emailRedirectTo:`${location.origin}${location.pathname}`}});
      if (error) throw error;
      if (data.session) {
        await refreshUser();
        toast('Welcome to Loop.', 'success');
        location.hash = '#/feed';
      } else {
        toast('Check your email to confirm your account, then sign in.', 'success');
        location.hash = '#/login';
      }
    } else {
      const {error} = await db.auth.signInWithPassword({email,password});
      if (error) throw error;
      await refreshUser();
      toast('Welcome back.', 'success');
      location.hash = '#/feed';
    }
  }

  async function signOut() {
    // Sign out this browser session only; the same account can remain signed in elsewhere.
    const {error} = await db.auth.signOut({scope:'local'});
    if (error) throw error;
    currentUser = null;
    myProfile = null;
    activeChatPeer = null;
    updateUserNav();
    await updateBadges();
    setupRealtime();
    toast('You have signed out.', 'success');
    if (location.hash === '#/feed' || location.hash === '') render();
    else location.hash = '#/feed';
  }

  async function render() {
    setActiveNav();
    const hash = location.hash || '#/feed';
    const [route, ...parts] = hash.slice(2).split('/');
    activeChatPeer = route === 'dm' ? parts[0] : null;
    if (photoViewTimer) { clearTimeout(photoViewTimer); photoViewTimer = null; }
    if (route !== 'post') { photoViewPostId = null; activeVideoView = null; }
    if (route === 'feed' || !route) return renderFeed();
    if (route === 'saved') return renderSaved();
    if (route === 'notifications') return renderNotifications();
    if (route === 'messages') return renderMessages();
    if (route === 'dm') return renderChat(parts[0]);
    if (route === 'profile' && parts.length) return renderProfile(decodeURIComponent(parts[0]));
    if (route === 'profile' && !parts.length) return currentUser ? renderProfile(myProfile?.username) : renderAuth('login');
    if (route === 'post') return renderPostPage(parts[0]);
    if (route === 'upload') return renderUpload();
    if (route === 'edit-profile') return renderEditProfile();
    if (route === 'discover') return renderDiscover();
    if (route === 'login' || route === 'register') return renderAuth(route);
    return renderFeed();
  }

  // The account controls are outside #view, so they need their own delegated listener.
  userNav.addEventListener('click', async event => {
    const signOutButton = event.target.closest('[data-action="signout"]');
    if (!signOutButton) return;
    event.preventDefault();
    if (signOutButton.disabled) return;
    signOutButton.disabled = true;
    try {
      await signOut();
    } catch (error) {
      handleError(error, 'Could not sign out. Please try again.');
      if (signOutButton.isConnected) signOutButton.disabled = false;
    }
  });

  // Global event delegation keeps navigation and actions working after page changes.
  view.addEventListener('click', async event => {
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      const action = actionElement.dataset.action;
      try {
        if (action === 'bookmark') { event.preventDefault(); await toggleBookmark(actionElement.dataset.id,actionElement); }
        else if (action === 'delete-post') {
          event.preventDefault();
          const id = actionElement.dataset.id;
          confirmAction('Delete this post?','Your photo or video and its comments will be removed. This cannot be undone.','Delete post',() => deletePost(id));
        }
        else if (action === 'edit-profile') { location.hash = '#/edit-profile'; }
        else if (action === 'mark-all-read') { await markAllNotificationsRead(); }
        else if (action === 'reload') { render(); }
      } catch (error) { handleError(error); }
    }
    const notificationLink = event.target.closest('[data-notification]');
    if (notificationLink) markNotification(notificationLink.dataset.notification);
  });

  view.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const submitButton = $('button[type="submit"]',form);
    if (submitButton) { submitButton.disabled = true; submitButton.dataset.originalText = submitButton.textContent; submitButton.textContent = 'Please wait…'; }
    try {
      if (form.id === 'auth-form') await submitAuth(location.hash.includes('register') ? 'register' : 'login');
      else if (form.id === 'upload-form') await uploadPost();
      else if (form.id === 'profile-form') await saveProfile();
      else if (form.id === 'comment-form') {
        const postId = location.hash.split('/')[2];
        await sendComment(postId);
      }
      else if (form.id === 'chat-form') {
        const peerId = location.hash.split('/')[2];
        await sendMessage(peerId);
      }
    } catch (error) { handleError(error); }
    finally {
      if (submitButton?.isConnected) { submitButton.disabled = false; submitButton.textContent = submitButton.dataset.originalText || 'Submit'; }
    }
  });

  view.addEventListener('input', event => {
    if (event.target.id === 'comment-body') {
      const words = event.target.value.trim().split(/\s+/).filter(Boolean).length;
      const counter = $('#comment-word-count');
      if (counter) { counter.textContent = `${words} / 100 words`; counter.style.color = words > 100 ? '#a34138' : ''; }
    }
  });

  confirmAccept.addEventListener('click', event => {
    event.preventDefault();
    const action = pendingConfirmAction;
    pendingConfirmAction = null;
    confirmDialog.close();
    if (action) action();
  });
  confirmDialog.addEventListener('click', event => { if (event.target === confirmDialog) confirmDialog.close(); });
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && photoViewTimer) { clearTimeout(photoViewTimer); photoViewTimer = null; }
    else if (document.visibilityState === 'visible' && photoViewPostId) armPhotoViewTimer();
  });

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
      currentUser = session?.user || null;
      // Avoid awaiting Supabase calls in the auth callback; refresh after this event turn.
      setTimeout(async () => { await refreshUser(); if (!location.hash) location.hash = '#/feed'; else render(); }, 0);
    }
  });

  (async () => {
    await refreshUser();
    await render();
  })();
})();
