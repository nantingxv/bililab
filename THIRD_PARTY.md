# 第三方组件

本项目在 `static/` 下内置了两个前端库（为了离线可用，不走 CDN）：

| 文件 | 组件 | 版本 | 许可证 |
|---|---|---|---|
| `static/echarts.min.js` | [Apache ECharts](https://echarts.apache.org/) | 5.x | Apache License 2.0 |
| `static/qrcode.js` | [QRCode.js](https://github.com/davidshimjs/qrcodejs) | — | MIT |

两者的原始许可证声明均保留在文件头部，未做修改。

除此之外，后端**没有**任何第三方依赖，全部使用 Python 标准库。
