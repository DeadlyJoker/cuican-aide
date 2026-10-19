# 视频技术检查与审核帧

`MediaReviewVideoInspector` 是 Worker 内部的本地检测器。宿主提供已获读取授权的 MP4 字节、确切字节摘要、抽帧时间和取消信号；工具及模型不能提供可执行路径、输入文件名、URL 或过滤表达式。调用检测器本身不授予模型发送、生成或发布权限。Native 的作品资格、审核 job 准入及恢复绑定仍待接入。

输入默认最多 256MiB，宿主配置上限 1GiB；影片最长十分钟，视频边长最多 4096、平均帧率最多 120，最多八条流且仅一条视频、至多一条音轨。明确支持的 MP4 主品牌之外的输入拒绝，不把 QuickTime 或播放列表当作 MP4。未知时长、像素比例等字段不会填成零或默认为通过。

检测前将原生字节分成不超过 64KiB 的块，复制至宿主私有临时目录，并校验实际写入字节的 SHA-256。目录为 0700、快照完成后为 0400；不调用输入自定义的 subarray、species、长度或偏移 getter。FFprobe 和 FFmpeg 先后使用同一快照的独立只读 fd，校验 inode、设备和大小。输入协议只允许 fd，外部 track 和绝对别名路径关闭；固定输出仅在本次目录内。

普通 MP4 的索引可能在片尾，不能一律用不可 seek 的 stdin 管道读取。这里使用支持 seek 的 [FFmpeg fd 协议](https://ffmpeg.org/ffmpeg-protocols.html#fd)。宿主路径由现有部署明确配置，不搜索或下载解码器，不继承凭据、代理或 codec 搜索环境。当前实测为本机现有 FFmpeg/FFprobe 8.0.1；尚未验证或打包其他桌面平台的二进制及分发许可。

一次完整解码同时生成指定的审核帧。一路不限帧数地解码视频及音频至结尾，另一路按宿主指定的时间选择帧，不为每个时间点重新解码。最多 24 个时间点，JPEG 边长不超过 512、每张最多 256KiB、返回图像总量最多 4MiB。旋转和像素比例参与显示几何处理；[scale reset_sar](https://ffmpeg.org/ffmpeg-filters.html#scale-1) 输出方形像素的审核图。

帧时间来自 [image2 frame_pts](https://ffmpeg.org/ffmpeg-formats.html#image2-2)，精度一毫秒，时间原点明确为第一视频帧；同时保留 requestedTimeMs 与 actualTimeMs。例如 24fps 输入请求 1050ms，实际帧可能为 1083ms。两个目标落在同一源帧时拒绝不完整覆盖，不复制同一帧冒充两次观察。音视频起始时间另外保留，不能把视频相对时间直接当成工程时间线的绝对时间。

图片缩图与视频检测共用一个进程内执行名额，无无界队列；codec/filter 单线程，视频整次操作 120 秒截止。取消或关闭先终止真实子进程并等待 close，再关闭 fd、清理本次目录和释放名额。清理检查目录身份，保留旁边的文件。当前只验证正常结束、取消和失败的清理；宿主崩溃后的残留目录恢复尚未接入 Native 生命周期。

`reviewProjectMediaVideoTechnical` 接收宿主测得的元数据和明确交付策略，核对完整解码、时长、显示画幅、分辨率、帧率、编码、音轨存在及采样率、音视频轨起止偏差。技术通过仅返回 ready-for-editorial-review。剧情、运动、对白、口型、字幕和商业使用依据仍列为 notChecked；音轨长度匹配不证明口型同步，抽样图也不证明整片视觉通过。

测试使用具名红蓝色块与正弦音轨 MP4，通过真实 FFmpeg 编码、FFprobe 读取、完整解码及 JPEG 像素验证。测试片不是《重录》成片，不是实际模型审片；未提交真实生成、上传或模型请求。证据见 `output/short-drama-rehearsal-20261015/video-inspection-acceptance.json`。
