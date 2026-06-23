import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
  type TouchEvent,
} from 'react';
import { parseSgr } from '@rcc/shared';
import { api } from '../lib/api';

/**
 * 终端历史阅读层：原生 <pre> 文本流，浏览器原生选中/顺滑滚动；
 * 反向无限滚动——滚到顶取更早一窗 prepend 并保持滚动位置不跳。懒加载，传输小块。
 * 与实时终端零共享可变状态：仅经只读 HTTP `api.getScrollback` 取真实屏字符(已 -e 着色、-J 合并、trimEnd)。
 * 切换力求无感：进入时底下实时终端先露着(loaded 前透明)避免空白闪；在底部继续下滚即退回实时。
 */
const WINDOW = 120; // 每窗行数:小→加载快且滚一会儿就触发下一窗;原 800 太多、彩色 span 渲染慢

export function ScrollbackReader({
  projectId,
  convId,
  onClose,
}: {
  projectId: string;
  convId: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [before, setBefore] = useState<number | null>(null); // 下一更早窗游标；null=无更早
  const [atTop, setAtTop] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false); // 首窗就绪前保持透明、露出底下实时终端,避免“文字消失”
  const loadingRef = useRef(false); // 同步防重入闩（setLoading 异步，挡不住同一 tick 的二次触发）
  const awayFromBottomRef = useRef(false); // 是否曾离开底部（避免初次贴底就误触发退回）
  const touchStartY = useRef(0);
  // prepend 后保持滚动位置不跳：记录“prepend 前一刻”的高度与偏移,绘制前用正确公式还原。
  const restoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

  // 初次：取最新一窗、贴底。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getScrollback(projectId, convId, undefined, WINDOW)
      .then((chunk) => {
        if (cancelled) return;
        setLines(chunk.lines);
        setBefore(chunk.atTop ? null : chunk.nextBefore);
        setAtTop(chunk.atTop);
        awayFromBottomRef.current = false;
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, convId]);

  const loadOlder = useCallback(async () => {
    if (loadingRef.current || atTop || before == null) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const chunk = await api.getScrollback(projectId, convId, before, WINDOW);
      // 关键:在 prepend「那一刻」量高度/偏移(而非请求发出时,期间用户可能还在滚)。
      const el = scrollRef.current;
      restoreRef.current = el
        ? { prevHeight: el.scrollHeight, prevTop: el.scrollTop }
        : null;
      setLines((cur) => [...chunk.lines, ...cur]);
      setBefore(chunk.atTop ? null : chunk.nextBefore);
      setAtTop(chunk.atTop);
    } catch {
      /* ignore */
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [atTop, before, projectId, convId]);

  // prepend 落地后、浏览器绘制前还原滚动位置:新 scrollTop = 旧偏移 + 新增高度。
  // 用 useLayoutEffect(同步,绘制前)而非 rAF,彻底消除「一跳一跳」。
  useLayoutEffect(() => {
    const r = restoreRef.current;
    const el = scrollRef.current;
    if (r && el) {
      el.scrollTop = r.prevTop + (el.scrollHeight - r.prevHeight);
      restoreRef.current = null;
    }
  }, [lines]);

  const atBottom = () => {
    const el = scrollRef.current;
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight <= 2 : false;
  };

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distToBottom > 24) awayFromBottomRef.current = true;
    // 提前一屏预取下一窗,让向上滚动连续、不用滚到顶才刷新。
    if (el.scrollTop <= el.clientHeight) void loadOlder();
    // 上滚读过历史后又滚回底部 → 退回实时终端。
    if (awayFromBottomRef.current && distToBottom <= 4) onClose();
  }, [loadOlder, onClose]);

  // 在底部继续向下滚（滚轮/触摸）→ 立刻退回实时,无需先上滚再下滚。
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaY > 0 && atBottom()) onClose();
  };
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    touchStartY.current = e.touches[0]?.clientY ?? 0;
  };
  const onTouchMove = (e: TouchEvent<HTMLDivElement>) => {
    const dy = (e.touches[0]?.clientY ?? 0) - touchStartY.current;
    if (dy < -36 && atBottom()) onClose(); // 手指上移=内容向下滚,且已在底部
  };

  // 解析 ANSI 颜色为带样式文本段(着色)。
  const parsed = useMemo(() => lines.map((l) => parseSgr(l)), [lines]);
  // loading 引用一下以避免 unused warning;阅读端不再显示提示行,但状态留着做未来扩展(预取等)。
  void loading;

  return (
    <div className={`sb-reader${loaded ? ' loaded' : ''}`}>
      <div className="sb-toolbar">
        <button className="btn ghost sm" onClick={onClose}>
          返回实时
        </button>
      </div>
      <div
        className="sb-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        {atTop && <div className="sb-cap">— 历史起点 —</div>}
        <pre className="sb-text">
          {parsed.map((segs, i) => (
            <span key={i}>
              {segs.map((s, j) => (
                <span
                  key={j}
                  style={{ color: s.fg, background: s.bg, fontWeight: s.bold ? 600 : undefined }}
                >
                  {s.text}
                </span>
              ))}
              {i < parsed.length - 1 ? '\n' : ''}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}
