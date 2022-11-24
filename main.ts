import { Editor, MarkdownView, Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, IObsidianSetting, S3ClientSettings, SettingsTab } from 'src/settings';
import { S3Server } from 'src/httpServer';
import { mimeType } from 'src/constants';
import { S3Client } from 'src/s3Client';
import prettyBytes from 'pretty-bytes';
import { generateResourceName, getS3Path, getS3URLs } from 'src/helper';


function allFilesAreValidUploads(files: FileList) {
	if (files.length === 0) return false;
	let checked = true;
	console.log(files);
	for (let i = 0; i < files.length; i += 1) {
		if (files[i].size == 0) {
			new Notice(`Error: File is of 0 size.`);
			checked = false;
		}
		if (!Array.from(mimeType.values()).includes(files[i].type)) {
			new Notice(`Error: File of type ${files[i].type} is not supported by Obsidian with external links.`);
			checked = false;
		}
	}

	return checked;
}

function isValidSettings(settings: IObsidianSetting) {
	const { clients, port } = settings;
	if (isNaN(parseInt(port))) return false;
	let check = true;
	for (let i = 0; i < clients.length; i++) {
		const { accessKey, secretKey, endPoint, bucketName } = clients[i];
		if (accessKey == '' || secretKey == '' || endPoint == '' || bucketName == '') {
			new Notice(`Please fill in the parameters for ${clients[i].id}`);
			check = false;
		}

	}
	return check;
}

function createClients(clientSettings: S3ClientSettings[]) {
	const s3: S3Client[] = []
	settings.clients.forEach((c) => {
		s3.push(new S3Client(c.endPoint, c.accessKey, c.secretKey, c.bucketName, c.folderName, c.id));
	})
	return s3;
}

export let settings: IObsidianSetting = DEFAULT_SETTINGS;
export let server: S3Server = new S3Server(createClients(settings.clients), settings.port);
export default class ObsidianS3 extends Plugin {
	pluginName = "Obsidian S3";
	get s3() {
		return server.getClient(settings.activeClient);
	}
	credentialsError() {
		new Notice("Please fill out S3 credentials to enable the Obsidian S3 plugin.");
		return true;
	}
	getActive() {
		const res = settings.clients.find((c) => c.id === settings.activeClient);
		if (res) return res;
		else return settings.clients[0];
	}

	getClientIDs() {
		return settings.clients.map((c) => c.id);
	}

	async onload() {
		console.log(`Loading ${this.pluginName}`);
		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		this.setupHandlers();
		if (this.tryStartService()) {
			this.addCommand({
				id: 'obsidian-s3-clear-unused',
				name: 'Clear unused s3 objects.',
				callback: this.clearUnusedCallback.bind(this),
			});

			this.addCommand({
				id: 'obsidian-s3-get-obsidian-size',
				name: 'Get usage statistics.',
				callback: async () => {
					new Notice("Indexing...");
					const ids = this.getClientIDs();
					for (let i = 0; i < ids.length; i++) {
						const s3 = server.getClient(ids[i])
						new Notice(`[${ids[i]} client]\nObsidian usage: ${prettyBytes(await s3.getBucketSize())}\nAll usage: ${prettyBytes(await s3.getBucketSize(true))}`);
					}
				},
			});

		} else {
			return this.credentialsError();
		}
	}

	async clearUnusedCallback() {
		const { vault } = this.app;
		const files = vault.getMarkdownFiles();

		new Notice('Indexing resources...');
		const obsidianUrls = (await getS3URLs(files, vault, server.url)).map((u) => new URL(u));

		const ids = this.getClientIDs();
		for (let i = 0; i < ids.length; i++) {
			new Notice(`[${ids[i]}] Indexing S3 objects...`);
			const filter = obsidianUrls.filter((u) => u.searchParams.get("client") === ids[i]).map((u) => getS3Path(u));

			const s3 = server.getClient(ids[i]);
			const s3Index = await s3.listObjects();
			const doDelete = s3Index.filter((i) => !filter.includes(i.name));
			if (doDelete.length === 0) {
				new Notice(`[${ids[i]}] No object to delete.`);
				continue;
			}
			new Notice(`[${ids[i]}] Found ${doDelete.length} un-used objects, deleting...`);
			for (let i = 0; i < doDelete.length; i++) {
				console.log(`[${ids[i]}] S3: Deleting ${doDelete[i].name}`);
				// await this.s3.removeObject(doDelete[i].name);
			}
			new Notice(`[${ids[i]}] Deleted ${doDelete.length} objects.`)
			new Notice(`[${ids[i]}] Current bucket size ${prettyBytes(await s3.getBucketSize())}`)
		}

	}

	tryStartService(): boolean {
		if (isValidSettings(settings)) {
			new Notice(`Creating S3 Clients`);
			server = new S3Server(createClients(settings.clients), settings.port);
			server.listen();
			return true;
		} else {
			return false;
		}
	}

	onunload() {
		server.close();
	}

	async loadSettings() {
		settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as IObsidianSetting);
	}

	async saveSettings() {
		await this.saveData(settings);
	}

	private async pasteEventHandler(e: ClipboardEvent, _: Editor, markdownView: MarkdownView) {
		if (!this.s3) return this.credentialsError();
		if (!e.clipboardData) return;
		const files = e.clipboardData.files;

		if (!allFilesAreValidUploads(files)) return;
		e.preventDefault();

		await this.uploadFiles(files);
	}
	private async dropEventHandler(e: DragEvent, _: Editor, markdownView: MarkdownView) {
		if (!this.s3) return this.credentialsError();
		if (!e.dataTransfer) return;
		if (!e.dataTransfer.types.length || !e.dataTransfer.types.includes("Files")) return;

		const { files } = e.dataTransfer;

		if (!allFilesAreValidUploads(files)) return;

		e.preventDefault();
		await this.uploadFiles(files);
	}

	private setupHandlers() {
		this.registerEvent(
			this.app.workspace.on("editor-paste", this.pasteEventHandler.bind(this))
		);
		this.registerEvent(
			this.app.workspace.on("editor-drop", this.dropEventHandler.bind(this))
		);
	}

	public writeLine(newLine: string) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		if (!view) return new Notice('Error: No active view.');

		const { editor } = view;
		if (!editor) return new Notice(`Error: no active editor`);


		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		editor.transaction({
			changes: [
				{
					from: { ...cursor, ch: 0, },
					to: { ...cursor, ch: line.length, },
					text: newLine + "\n",
				}
			]
		})
		cursor.line += 1;
		editor.setCursor(cursor);
	}

	private async uploadFiles(files: FileList) {
		for (let i = 0; i < files.length; i += 1) {
			const file = files[i];
			const fileName = generateResourceName(file.name, this.app.workspace.getActiveFile()?.basename);

			new Notice(`Uploading: ${fileName} ${prettyBytes(file.size)} ...`);
			try {
				const s3 = this.s3;
				let progress = 0;
				const handle = window.setInterval(() => new Notice(`Uploading: ${fileName} ${progress}%`), 5000);
				this.registerInterval(handle);
				await s3.upload(file, fileName,
					(prog) => progress = prog,
					() => window.clearInterval(handle));

				const url = s3.createObjURL(server.url, fileName);

				let linkTxt = `![S3 File](${url})`
				if (file.type.startsWith('video') || file.type.startsWith('audio')) {
					linkTxt = `<iframe src="${url}" alt="${fileName}" style="overflow:hidden;height:400;width:100%" allowfullscreen></iframe>`;
				} else if (file.type === 'text/html') {
					linkTxt = `<iframe src="${url}"></iframe>`
				}

				this.writeLine(linkTxt);
			}
			catch (e) {
				new Notice(`Error: Unable to upload ${fileName}. Make sure your S3 credentials are correct.`);
				return console.log(e);
			}
		}
	}

}

