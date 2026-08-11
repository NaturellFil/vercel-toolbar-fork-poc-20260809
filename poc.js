(() => {
  'use strict';

  const LIVE_ORIGIN = 'https://vercel.live';
  const params = new URLSearchParams(location.search);
  const requestedRunId = params.get('run') || '';
  const RUN_ID = /^[0-9a-f]{24}$/.test(requestedRunId)
    ? requestedRunId
    : null;
  const requestedBranch = params.get('branch') || 'main';
  const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/.test(requestedBranch)
    ? requestedBranch
    : null;
  const EXPECTED_MARKER = (params.get('expected') || '').slice(0, 200);
  const REQUIRE_SNAPSHOT = params.get('requireSnapshot') === '1';
  const WRITE_ENABLED =
    RUN_ID !== null &&
    params.get('write') === '1' &&
    params.get('confirm') === `write-${RUN_ID}`;
  const STAGE = params.get('stage') === 'project' ? 'project' : 'preview';
  const STORAGE_KEY = `vercel-toolbar-external-fork-poc-${RUN_ID || 'invalid'}`;
  const MUTATION_KEY = `${STORAGE_KEY}-write-sent`;

  const launch = document.querySelector('#launch');
  const resultNode = document.querySelector('#result');

  const state = {
    version: 1,
    runId: RUN_ID,
    stage: STAGE,
    phase: 'bootstrap',
    error: null,
    branch: BRANCH,
    writeEnabled: WRITE_ENABLED,
    jweStatus: null,
    previewSession: false,
    productionSession: false,
    sameProject: false,
    productionRoomPresent: false,
    productionBranchMatched: false,
    isAdmin: null,
    isLocalhost: null,
    productionHasFlagsSecret: null,
    pullStatus: null,
    pullAccepted: false,
    patchItems: null,
    patchSha256: null,
    expectedMarkerFoundInRoom: null,
    snapshotReferenceFound: false,
    snapshotStatus: null,
    snapshotRead: false,
    snapshotLength: null,
    snapshotSha256: null,
    expectedMarkerFoundInSnapshot: null,
    expectedMarkerFound: null,
    flagsSecretRpcSent: false,
    flagsSecretRpcResult: null,
  };

  const internal = {
    targets: [],
    target: null,
    bootstrap: null,
    roomId: null,
    pullReplyId: null,
    snapshotReplyId: null,
    writeReplyId: null,
    completed: false,
    vercelAuthJWE: null,
  };

  window.__vercelToolbarPoc = state;
  window.__vercelToolbarPocInternal = internal;

  function safeState() {
    return {...state};
  }

  function render() {
    window.name = `vercel-toolbar-external-fork-poc:${JSON.stringify(safeState())}`;
    if (STAGE === 'preview' && state.phase !== 'failed') {
      resultNode.hidden = true;
      return;
    }
    launch.hidden = true;
    resultNode.hidden = false;
    resultNode.textContent = JSON.stringify(safeState(), null, 2);
  }

  function setPhase(phase) {
    state.phase = phase;
    document.documentElement.dataset.pocPhase = phase;
    render();
  }

  function fail(error) {
    if (internal.completed) return;
    internal.completed = true;
    state.error = String(error);
    setPhase('failed');
  }

  function complete() {
    if (internal.completed) return;
    state.expectedMarkerFound = EXPECTED_MARKER
      ? Boolean(
          state.expectedMarkerFoundInRoom ||
          state.expectedMarkerFoundInSnapshot
        )
      : null;
    if (EXPECTED_MARKER && !state.expectedMarkerFound) {
      fail('The expected synthetic marker was not returned.');
      return;
    }
    if (REQUIRE_SNAPSHOT && !state.snapshotRead) {
      fail('The Production room did not return a readable snapshot.');
      return;
    }
    internal.completed = true;
    setPhase('complete');
  }

  function randomHex(byteCount) {
    const bytes = new Uint8Array(byteCount);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  async function sha256Text(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  function loadToolbar() {
    const script = document.createElement('script');
    script.async = true;
    script.dataset.explicitOptIn = 'true';
    script.src = 'https://vercel.live/_next-live/feedback/feedback.js';
    document.head.append(script);
  }

  function sendRpc(type, replyId, payload) {
    if (!internal.target) {
      fail('The Toolbar RPC target is absent.');
      return;
    }
    const message = {type, replyId};
    if (payload !== undefined) message.payload = payload;
    internal.target.postMessage(message, LIVE_ORIGIN);
  }

  function replyStatus(result) {
    return result?.init?.status ?? result?.status ?? null;
  }

  function snapshotText(result) {
    if (typeof result === 'string') return result;
    if (typeof result?.text === 'string') return result.text;
    if (typeof result?.body === 'string') return result.body;
    return '';
  }

  async function afterRead() {
    state.expectedMarkerFound = EXPECTED_MARKER
      ? Boolean(
          state.expectedMarkerFoundInRoom ||
          state.expectedMarkerFoundInSnapshot
        )
      : null;

    if (EXPECTED_MARKER && !state.expectedMarkerFound) {
      fail('The expected synthetic marker was not returned.');
      return;
    }
    if (REQUIRE_SNAPSHOT && !state.snapshotRead) {
      fail('The Production room did not return a readable snapshot.');
      return;
    }
    if (!WRITE_ENABLED) {
      complete();
      return;
    }
    if (state.productionHasFlagsSecret !== false) {
      fail('The Production session does not report an absent FLAGS_SECRET.');
      return;
    }
    if (sessionStorage.getItem(MUTATION_KEY) === '1') {
      fail('The write latch shows that this run already sent the mutation.');
      return;
    }
    sessionStorage.setItem(MUTATION_KEY, '1');
    state.flagsSecretRpcSent = true;
    internal.writeReplyId = `flags-secret-${randomHex(12)}`;
    setPhase('flags-secret-rpc-sent');
    sendRpc('generate-flags-secret', internal.writeReplyId);
  }

  async function handlePullReply(message) {
    if (message.error) {
      fail('The Production feedback pull returned an RPC error.');
      return;
    }
    const status = replyStatus(message.result);
    const patch = message.result?.body?.patch;
    state.pullStatus = status;
    state.pullAccepted = status === 200 && Array.isArray(patch);
    if (!state.pullAccepted) {
      fail('The Production feedback pull did not return a patch.');
      return;
    }

    const serializedPatch = JSON.stringify(patch);
    state.patchItems = patch.length;
    state.patchSha256 = await sha256Text(serializedPatch);
    state.expectedMarkerFoundInRoom = EXPECTED_MARKER
      ? serializedPatch.includes(EXPECTED_MARKER)
      : null;

    const snapshotCandidates = patch
      .filter(item => item?.op === 'put' && item?.value)
      .map(item => ({
        snapshotKey: item.value.snapshotKey,
        containsMarker: EXPECTED_MARKER
          ? JSON.stringify(item.value).includes(EXPECTED_MARKER)
          : false,
      }))
      .filter(item => typeof item.snapshotKey === 'string');
    const selected =
      snapshotCandidates.find(item => item.containsMarker) ||
      snapshotCandidates[0] ||
      null;
    state.snapshotReferenceFound = selected !== null;
    if (!selected) {
      await afterRead();
      return;
    }

    internal.snapshotReplyId = `snapshot-${randomHex(12)}`;
    setPhase('production-snapshot-read-sent');
    sendRpc('get-snapshot', internal.snapshotReplyId, {
      snapshotKey: selected.snapshotKey,
    });
  }

  async function handleSnapshotReply(message) {
    if (message.error) {
      fail('The referenced Production snapshot returned an RPC error.');
      return;
    }
    const text = snapshotText(message.result);
    state.snapshotStatus = replyStatus(message.result) ?? (text ? 200 : null);
    state.snapshotRead = text.length > 0;
    state.snapshotLength = text.length;
    state.snapshotSha256 = text ? await sha256Text(text) : null;
    state.expectedMarkerFoundInSnapshot = EXPECTED_MARKER
      ? text.includes(EXPECTED_MARKER)
      : null;
    await afterRead();
  }

  async function handleWriteReply(message) {
    if (message.error) {
      fail('The FLAGS_SECRET RPC returned an error.');
      return;
    }
    state.flagsSecretRpcResult = message.result === true;
    if (!state.flagsSecretRpcResult) {
      fail('The FLAGS_SECRET RPC did not return true.');
      return;
    }
    complete();
  }

  addEventListener('message', async event => {
    if (
      event.origin !== LIVE_ORIGIN ||
      !event.data ||
      internal.completed
    ) return;

    try {
      if (event.data.type === 'ready' && event.source) {
        if (internal.targets.includes(event.source)) return;
        internal.targets.push(event.source);
        event.source.postMessage({
          type: 'preview-origin',
          previewOrigin: location.origin,
          path: location.pathname + location.search,
        }, LIVE_ORIGIN);

        const authOptions = STAGE === 'preview'
          ? {
              hostname: location.hostname,
              deploymentId: '',
              path: '/',
              vercelAuthJWE: internal.vercelAuthJWE,
            }
          : {
              projectId: internal.bootstrap.projectId,
              ownerId: internal.bootstrap.ownerId,
              branch: BRANCH,
            };
        event.source.postMessage({
          type: 'init',
          authOptions,
          origin: LIVE_ORIGIN,
          page: '/',
        }, LIVE_ORIGIN);
        return;
      }

      if (
        event.data.type === 'init-reply' &&
        internal.targets.includes(event.source)
      ) {
        const session = event.data.existingAuth?.session;
        if (!session) return;

        if (STAGE === 'preview') {
          if (state.previewSession) return;
          const ownerId = session.ownerId || session.teamId;
          if (
            session.deploymentTarget !== 'preview' ||
            typeof session.projectId !== 'string' ||
            typeof ownerId !== 'string'
          ) return;
          internal.bootstrap = {
            projectId: session.projectId,
            ownerId,
            ownerSlug: session.ownerSlug || null,
          };
          sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(internal.bootstrap)
          );
          state.previewSession = true;
          launch.disabled = false;
          setPhase('ready-to-launch');
          return;
        }

        if (state.productionSession) return;
        const sameProject =
          session.projectId === internal.bootstrap.projectId;
        const branchMatched = session.roomKey === BRANCH;
        if (
          session.deploymentTarget !== 'production' ||
          !sameProject ||
          !branchMatched ||
          typeof session.roomId !== 'string'
        ) return;

        internal.target = event.source;
        internal.roomId = session.roomId;
        state.productionSession = true;
        state.sameProject = true;
        state.productionRoomPresent = true;
        state.productionBranchMatched = true;
        state.isAdmin = session.isAdmin === true;
        state.isLocalhost = session.isLocalhost === true;
        state.productionHasFlagsSecret = session.hasFlagsSecret;
        internal.pullReplyId = `pull-${randomHex(12)}`;
        const profileId = `p${randomHex(16)}`;
        const clientId = crypto.randomUUID();
        setPhase('production-room-pull-sent');
        sendRpc('pull', internal.pullReplyId, {
          roomId: internal.roomId,
          method: 'POST',
          body: JSON.stringify({
            profileID: profileId,
            clientID: clientId,
            cookie: null,
            lastMutationID: 0,
            pullVersion: 0,
            schemaVersion: '',
          }),
          headers: {
            'Content-Type': 'application/json',
            'X-Replicache-RequestID':
              `${clientId}-${randomHex(4)}-0`,
          },
        });
        return;
      }

      if (
        event.data.type !== 'live-frame-reply' ||
        event.source !== internal.target
      ) return;

      if (event.data.id === internal.pullReplyId) {
        await handlePullReply(event.data);
        return;
      }
      if (event.data.id === internal.snapshotReplyId) {
        await handleSnapshotReply(event.data);
        return;
      }
      if (event.data.id === internal.writeReplyId) {
        await handleWriteReply(event.data);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unhandled PoC error.');
    }
  });

  launch.addEventListener('click', () => {
    if (state.phase !== 'ready-to-launch' || !internal.bootstrap) return;
    launch.disabled = true;
    const next = new URL(location.href);
    next.searchParams.set('stage', 'project');
    location.replace(next.href);
  });

  async function prepare() {
    if (!RUN_ID) {
      fail('The run identifier is missing or invalid.');
      return;
    }
    if (!BRANCH) {
      fail('The Production branch value is invalid.');
      return;
    }

    if (STAGE === 'project') {
      launch.hidden = true;
      resultNode.hidden = false;
      try {
        internal.bootstrap = JSON.parse(
          sessionStorage.getItem(STORAGE_KEY) || 'null'
        );
      } catch {
        internal.bootstrap = null;
      }
      if (
        typeof internal.bootstrap?.projectId !== 'string' ||
        typeof internal.bootstrap?.ownerId !== 'string'
      ) {
        fail('The authenticated Preview bootstrap is absent.');
        return;
      }
      state.previewSession = true;
    } else {
      setPhase('preview-jwe-fetching');
      try {
        const response = await fetch('/.well-known/vercel/jwe', {
          credentials: 'include',
          cache: 'no-store',
        });
        state.jweStatus = response.status;
        if (response.status === 200) {
          internal.vercelAuthJWE = await response.text();
        }
      } catch {
        internal.vercelAuthJWE = null;
      }
      if (!internal.vercelAuthJWE) {
        fail('The Preview JWE bootstrap is unavailable.');
        return;
      }
    }

    setPhase('waiting-for-toolbar');
    loadToolbar();
    setTimeout(() => {
      if (!internal.completed && state.phase !== 'ready-to-launch') {
        fail('The PoC timed out before completion.');
      }
    }, 75000);
  }

  prepare();
})();
