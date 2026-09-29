# 常用 User 置顶

酒馆助手全局脚本，把常用 User 按勾选顺序排到原生人设列表最前面。点击「📌 常用 User」选择并保存；停用后恢复原生排序。

## 安装与更新

下载 [pinned-user.json](https://raw.githubusercontent.com/koichole213-ui/tavern-pinned-user/main/pinned-user.json)，导入全局脚本并启用。

从 1.2.0 起改为指定版本加载，不再提供「检查更新」按钮，也不依赖修改脚本库的接口。

已有旧版时，可以编辑原脚本，将代码替换为 [loader.js](https://raw.githubusercontent.com/koichole213-ui/tavern-pinned-user/main/loader.js) 的全部内容，保存并重新启用。旧更新按钮自动移除，其他自定义按钮和置顶记录保留。

以后有新版时，只修改入口顶部这一行，保存并重新启用：

```js
const VERSION = '1.2.0';
```

版本必须已经发布。管理窗口顶部显示实际运行版本；导入说明中的版本只是导入时的记录。只有 1.2.0 及以后版本支持此入口，不能填写 1.1.x。

## 网络与数据

启用时通过 jsDelivr 读取对应 GitHub 标签下的代码，不自动追随最新版。网络不可用或版本不存在时提示加载失败，不删除置顶记录；重新启用可重试，网络和 CDN 缓存仍会影响可用性。

沿用旧版的 hehe_pinned_user_personas_v1 存储，只保存置顶头像 ID，不修改人设内容和头像。

## 版本

- 1.2.1：勾选、取消和全部取消时保持卡片及滚动位置；保存后应用顺序，下次打开管理窗口再优先显示已置顶项。
- 1.2.0：指定版本加载；删除更新按钮；说明文字改为「TA们」。
- 1.1.1：停用后恢复原生排序。
- 1.1.0：启动恢复、记录保留和分页修复。

## 维护与验证

修改 pinned-user.js 的功能和 SCRIPT_VERSION 后，运行 npm run build、npm test、node --check pinned-user.js 与 node --check loader.js。

构建同步 JSON、加载入口、说明、package 版本，并生成 pinned-user.module.js。发布时提交生成文件，创建并推送对应的 v版本号 标签。已发布标签不移动；仅改数字而不发布对应代码不能更新。

测试覆盖存储、慢加载、停用恢复，以及隔离浏览器中的加载入口和按钮迁移。真实酒馆体验仍需实际验证。
