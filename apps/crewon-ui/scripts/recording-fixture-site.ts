import { createServer } from "node:http";
/** Synthetic business material for recording and F03/F05 playback acceptance. */
export async function startRecordingFixtureSite(options: { port: number }) {
  const server = createServer((req, res) => {
    if (req.url === "/business.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(
        "document.getElementById('filter').addEventListener('click',()=>document.getElementById('result').textContent='已筛选：'+document.getElementById('channel').value);document.getElementById('next').addEventListener('click',()=>location.href='/orders/next?token=DO_NOT_EXPORT_QUERY');",
      );
      return;
    }
    if (req.url?.startsWith("/export")) {
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="orders.csv"',
      });
      res.end(
        "order_id,channel,currency,amount,status\nA001,direct,CNY,100,paid\nA002,direct,CNY,50,canceled\n",
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self'",
    });
    res.end(
      `<!doctype html><html lang="zh"><meta charset="utf-8"><title>合成订单后台</title><style>body{font:16px system-ui;margin:24px;background:#fff;color:#222}label{display:block;margin:16px 0}input,select,button,a{font:inherit;padding:8px;border:1px solid #888;border-radius:0;background:rgb(255,255,255);color:#222}button{background:rgb(240,240,240)}a{display:inline-block}table{border-collapse:collapse;margin:20px 0}td,th{border:1px solid #bbb;padding:8px}.secret{margin-top:24px}</style><h1>订单导出 · 合成材料</h1><p>教学：选择日期与渠道，筛选后下载 CSV。</p><label>日期 <input id="date" aria-label="日期" type="date" value="2026-09-01"></label><label>渠道 <select size="2" id="channel" aria-label="渠道"><option>直营</option><option>渠道</option></select></label><label>备注 <input id="note" aria-label="备注" type="text"></label><button id="filter">筛选订单</button><button id="help">查看说明</button><p id="result">所有订单</p><table><tr><th>订单</th><th>金额</th><th>状态</th></tr><tr><td>A001</td><td>100.00</td><td>paid</td></tr><tr><td>A002</td><td>50.00</td><td>canceled</td></tr></table><a id="download" href="/export.csv">下载 CSV</a><details class="secret"><summary>敏感字段测试</summary><label>密码 <input id="password" type="password" autocomplete="current-password"></label><label>API token <input id="api-token" type="text" name="api-token"></label></details><button id="next">下一页</button><script src="/business.js"></script></html>`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/orders?token=DO_NOT_EXPORT_QUERY`;
  return { server, url };
}
