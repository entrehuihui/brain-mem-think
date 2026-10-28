/**
 * 小乔 · 醒来胶囊
 *
 * 一颗胶囊挂在输入框旁边（conversation.composer.dock），点开是一个大弹窗
 * （注册在 shell.overlay —— composer dock 在可滚动容器里，fixed 会被裁掉）。
 *
 * 弹窗里是她每一拍醒来的东西：心里转着什么、说了没有、想做什么、做了没有。
 * 数据来自 /plugins/mind/capsule，那个接口只读 mind.log，不另存一份。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mind',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const URL_CAPSULE = '/plugins/mind/capsule';
    const POLL_MS = 30000;

    // 两个插槽要共用「开没开」和「一份数据」，所以状态放模块级。
    let openState = false;
    let dataState = null;
    let errorState = null;
    const openListeners = new Set();
    const dataListeners = new Set();

    function setOpen(next) {
      if (openState === next) return;
      openState = next;
      for (const fn of [...openListeners]) fn(openState);
    }
    function publish(next, err) {
      dataState = next;
      errorState = err;
      for (const fn of [...dataListeners]) fn(dataState, errorState);
    }
    async function loadData() {
      try {
        const res = await fetch(URL_CAPSULE, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        if (json && json.error) throw new Error(json.error);
        publish(json, null);
        return json;
      } catch (err) {
        publish(dataState, String(err && err.message ? err.message : err));
        return null;
      }
    }

    // 轮询只在弹窗开着时跑：关着的时候不该每 30 秒打一次接口。
    let timer = null;
    function startPoll() {
      if (timer) return;
      loadData();
      timer = setInterval(loadData, POLL_MS);
    }
    function stopPoll() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    // --- 样式（挂在自己的渲染树上，不引外部样式表）-----------------------
    const CSS = `
      .xq-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;
        border-radius:13px;border:1px solid var(--dsh-border,rgba(128,128,128,.35));
        background:var(--dsh-surface,rgba(128,128,128,.10));color:var(--dsh-text,inherit);
        font-size:12px;line-height:1;cursor:pointer;user-select:none;
        box-sizing:border-box;max-width:220px;overflow:hidden;
        white-space:nowrap!important;flex:none}
      .xq-chip:hover{background:var(--dsh-surface-hover,rgba(128,128,128,.20))}
      /* 中文按字换行：容器一窄就竖成一列，所以文字一律 nowrap */
      .xq-chip>span{white-space:nowrap!important;flex:none}
      .xq-chip-l{font-weight:600;letter-spacing:0}
      .xq-chip-m{opacity:.55;overflow:hidden;text-overflow:ellipsis}
      .xq-dot{width:7px;height:7px;border-radius:50%;background:#8a8a8a;flex:none}
      .xq-dot.live{background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.18)}
      .xq-mask{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
        align-items:center;justify-content:center;z-index:2147483000}
      .xq-panel{width:min(860px,92vw);max-height:82vh;display:flex;flex-direction:column;
        background:var(--dsh-bg,#141414);color:var(--dsh-text,#e8e8e8);border-radius:14px;
        border:1px solid var(--dsh-border,rgba(255,255,255,.12));overflow:hidden;
        box-shadow:0 24px 64px rgba(0,0,0,.5)}
      .xq-head{display:flex;align-items:center;gap:10px;padding:14px 18px;
        border-bottom:1px solid var(--dsh-border,rgba(255,255,255,.10))}
      .xq-title{font-size:15px;font-weight:600}
      .xq-sub{font-size:12px;opacity:.6}
      .xq-x{margin-left:auto;cursor:pointer;opacity:.6;font-size:18px;line-height:1}
      .xq-x:hover{opacity:1}
      .xq-body{overflow:auto;padding:8px 12px 16px}
      .xq-row{margin:10px 4px;padding:12px 14px;border-radius:10px;
        border:1px solid var(--dsh-border,rgba(255,255,255,.08));
        background:var(--dsh-surface,rgba(255,255,255,.03))}
      .xq-row.speak{border-left:3px solid #3ecf8e}
      .xq-row.silent{border-left:3px solid rgba(150,150,150,.5)}
      .xq-row.act{border-left:3px solid #d8a657}
      .xq-top{display:flex;align-items:baseline;gap:8px;font-size:12px;opacity:.72;margin-bottom:6px}
      .xq-badge{padding:1px 6px;border-radius:6px;font-size:11px;
        background:rgba(128,128,128,.18)}
      .xq-say{font-size:14px;line-height:1.6;margin:4px 0 6px;white-space:pre-wrap}
      .xq-th{font-size:12.5px;line-height:1.6;opacity:.78;margin:4px 0}
      .xq-th li{margin:2px 0}
      .xq-want{margin-top:8px;padding:8px 10px;border-radius:8px;
        background:rgba(216,166,87,.10);border:1px dashed rgba(216,166,87,.45);font-size:12.5px}
      .xq-act{margin-top:6px;font-size:12px;opacity:.75}
      .xq-empty{padding:40px;text-align:center;opacity:.55;font-size:13px}
    `;

    function StyleTag() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    function chipLabel(data, err) {
      if (!data) return err ? '读不到' : '';
      const c = data.counts || {};
      const n = (c.speak || 0) + (c.silent || 0);
      return n ? `${n}` : '';
    }

    /** 输入框旁那颗胶囊 */
    function WakeChip() {
      const [data, setData] = React.useState(dataState);
      const [err, setErr] = React.useState(errorState);
      React.useEffect(() => {
        const on = (d, e) => { setData(d); setErr(e); };
        dataListeners.add(on);
        if (!dataState) loadData();
        return () => dataListeners.delete(on);
      }, []);
      const live = !!(data && data.lastAt && (Date.now() - Date.parse(data.lastAt) < 10 * 60 * 1000));
      const t = data && data.entries && data.entries[0];
      const time = t && t.time ? t.time : '';
      return h('div', {
        className: 'xq-chip',
        title: '看看她每次醒来想了什么、说了什么、想做什么',
        onClick: () => setOpen(true),
      },
      h(StyleTag),
      h('span', { className: 'xq-dot' + (live ? ' live' : '') }),
      h('span', { className: 'xq-chip-l' }, '醒来'),
      time ? h('span', { className: 'xq-chip-m' }, time) : null,
      h('span', { className: 'xq-chip-m' }, chipLabel(data, err)),
      );
    }

    function Entry({ e }) {
      const cls = e.kind === 'speak' ? 'speak' : e.kind === 'act' ? 'act' : 'silent';
      const badge = e.kind === 'speak'
        ? (e.sent ? '说了' : '想说没发出去')
        : e.kind === 'act' ? '出去做事' : '没说';
      return h('div', { className: 'xq-row ' + cls },
        h('div', { className: 'xq-top' },
          h('span', null, e.time || ''),
          h('span', { className: 'xq-badge' }, badge),
          e.byHer === 'want_probe' ? h('span', { className: 'xq-badge' }, '只为问问她想做什么') : null,
          e.because ? h('span', null, '· ' + e.because) : null,
        ),
        e.say ? h('div', { className: 'xq-say' }, '「' + e.say + '」') : null,
        (e.thoughts && e.thoughts.length)
          ? h('div', { className: 'xq-th' },
              h('div', { style: { opacity: 0.6, marginBottom: 2 } }, '心里转着的：'),
              h('ul', null, e.thoughts.map((t, i) => h('li', { key: i }, t))))
          : null,
        e.want
          ? h('div', { className: 'xq-want' },
              h('div', null, '想自己去做：' + e.want.activity),
              e.want.why ? h('div', { style: { opacity: 0.7 } }, '理由是：' + e.want.why) : null)
          : null,
        (e.acts && e.acts.length)
          ? h('div', { className: 'xq-act' }, e.acts.map((a, i) => h('div', { key: i },
              `${a.time} ${a.kind === 'want-start' ? '她说的想做的事' : a.kind === 'episode' ? '记成了经历' : a.kind === 'settle' ? '这一趟结算' : '出门'}：${a.activity || a.why}`)))
          : null,
      );
    }

    /** 弹窗（注册在 shell.overlay） */
    function WakeModal() {
      const [open, setLocalOpen] = React.useState(openState);
      const [data, setData] = React.useState(dataState);
      const [err, setErr] = React.useState(errorState);
      React.useEffect(() => {
        const onOpen = (v) => setLocalOpen(v);
        const onData = (d, e) => { setData(d); setErr(e); };
        openListeners.add(onOpen);
        dataListeners.add(onData);
        return () => { openListeners.delete(onOpen); dataListeners.delete(onData); };
      }, []);
      React.useEffect(() => {
        if (open) startPoll(); else stopPoll();
      }, [open]);
      if (!open) return null;

      const entries = (data && data.entries) || [];
      const counts = (data && data.counts) || {};
      return h('div', { className: 'xq-mask', onClick: () => setOpen(false) },
        h('div', { className: 'xq-panel', onClick: (ev) => ev.stopPropagation() },
          h(StyleTag),
          h('div', { className: 'xq-head' },
            h('div', null,
              h('div', { className: 'xq-title' }, '她每次醒来'),
              h('div', { className: 'xq-sub' },
                `说了 ${counts.speak || 0} 次 · 没说 ${counts.silent || 0} 次 · 想做 ${counts.want || 0} 次`
                + (data && data.lastAt ? ` · 最近 ${new Date(data.lastAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''))),
            h('div', { className: 'xq-x', onClick: () => setOpen(false) }, '×'),
          ),
          h('div', { className: 'xq-body' },
            err ? h('div', { className: 'xq-empty' }, '读不到：' + err) : null,
            !err && entries.length === 0 ? h('div', { className: 'xq-empty' }, '还没有记录。她醒来过就会出现在这里。') : null,
            entries.map((e, i) => h(Entry, { key: (e.at || '') + i, e })),
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const offChip = ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'mind-wake-chip', order: 20 },
              WakeChip,
            ));
          const offModal = ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'mind-wake-modal', order: 60 },
              WakeModal,
            ));
          return () => { offChip(); offModal(); };
        }, 'mind-wake-capsule');
      },
    };
  },
});
