import blobToIt from "blob-to-it";
import { BucketItem, Client } from "minio";
import { Notice } from "obsidian";
import internal from "stream";

export class S3Client {
	id: string;
	client: Client | null;
	bucketName: string;
	folderName: string;

	constructor(endPoint: string, accessKey: string, secretKey: string, bucketName: string, folderName: string, id: string) {
		if (endPoint.startsWith('https://') || endPoint.startsWith('http://')) {
			const url = new URL(endPoint);
			endPoint = url.hostname;
		}


		this.bucketName = bucketName;
		this.folderName = folderName;
		this.id = id;
		try {
			this.client = new Client({
				endPoint,
				accessKey,
				secretKey,
				useSSL: true
			});
		} catch (e) {
			console.log(e);
			new Notice(`Error can't initialize S3 client ${id}. Please check that client configs are correct.`);
			this.client = null;
		}

	}

	public listObjects(all?: boolean) {
		return new Promise<BucketItem[]>((resolve) => {
			const s3Index: BucketItem[] = [];
			this.client?.listObjects(this.bucketName, all ? undefined : this.folderName, true)
				.on('data', (i) => {
					s3Index.push(i);
				})
				.on('end', () => {
					resolve(s3Index);
				});
		});
	}

	public upload(file: File, fileName: string, progress?: (prog: number) => void, cleanup?: () => void) {
		const readable = internal.Readable.from(blobToIt(file));
		let prog = 0;
		readable.on('data', (c: { length: number; }) => {
			prog += c.length;
			if (progress) progress(Math.round((prog / file.size) * 100));
		});
		readable.on('close', () => { if (cleanup) cleanup(); });
		return this.client?.putObject(this.bucketName,
			`${this.folderName}/${fileName}`, readable, file.size);
	}

	public getObject(path: string, bucketName?: string | null) {
		return this.client?.getObject(bucketName ?? this.bucketName, path);
	}

	public removeObject(path: string, bucketName?: string | null) {
		return this.client?.removeObject(bucketName ?? this.bucketName, path);
	}

	public createObjURL(url: string, fileName: string): string {
		// http://localhost:port/folder/object?client=id&bucket=bucketName.
		url = encodeURI(`${url}/${this.folderName}/${fileName}?client=${this.id}&bucket=${this.bucketName}`);
		return url;
	}

	public async getBucketSize(includeNonObsidian?: boolean) {
		return (await this.listObjects(includeNonObsidian)).map((i) => i.size).reduce((p, c) => p + c);
	}
}


