const got = require('got');
const semver = require('semver');
const config = require('config');
const GitHubApi = require('github');

const BaseRequest = require('./BaseRequest');
const Package = require('../../../models/Package');
const PackageVersion = require('../../../models/PackageVersion');
const sumDeep = require('../../utils/sumDeep');

const v1Config = config.get('v1');
const githubApi = new GitHubApi({
	Promise,
	protocol: 'https',
	host: v1Config.gh.sourceUrl,
	headers: { 'user-agent': 'jsDelivr API backend' },
	timeout: 30000,
});

if (v1Config.gh.apiToken) {
	githubApi.authenticate({
		type: 'token',
		token: v1Config.gh.apiToken,
	});
}

class PackageRequest extends BaseRequest {
	constructor (ctx) {
		super(ctx);

		this.keys = {
			files: `package/${this.params.type}/${this.params.name}@${this.params.version}/files`,
			metadata: `package/${this.params.type}/${this.params.name}/metadata`,
			packageStats: `package/${this.params.type}/${this.params.name}/stats`,
			versionsStats: `package/${this.params.type}/${this.params.name}@${this.params.version}/stats`,
		};
	}

	async fetchFiles () {
		return got(`${v1Config.cdn.sourceUrl}/${this.params.type}/${this.params.name}@${this.params.version}/+json`, { json: true, timeout: 30000 }).then((response) => {
			return _.pick(response.body, [ 'default', 'files' ]);
		}).catch((error) => {
			if (/*error instanceof got.HTTPError && */error.response.statusCode === 403) {
				return {
					status: error.response.statusCode,
					message: error.response.body,
				};
			}

			throw error;
		});
	}

	async fetchMetadata () {
		if (this.params.type === 'npm') {
			return fetchNpmMetadata(this.params.name);
		} else if (this.params.type === 'gh') {
			return fetchGitHubMetadata(this.params.user, this.params.repo);
		}

		throw new Error(`Unknown package type ${this.params.type}.`);
	}

	async getFiles () {
		return JSON.parse(await this.getFilesAsJson());
	}

	async getFilesAsJson () {
		let files = await redis.getAsync(this.keys.files);

		if (files) {
			return files;
		}

		files = JSON.stringify(await this.fetchFiles(), null, '\t');
		await redis.setAsync(this.keys.files, files);
		return files;
	}

	async getResolvedVersion () {
		return this.getMetadata().then((metadata) => {
			let versions = metadata.versions.filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);

			if (metadata.versions.includes(this.params.version)) {
				return this.params.version;
			} else if (metadata.tags.hasOwnProperty(this.params.version)) {
				return metadata.tags[this.params.version];
			} else if (this.params.version === 'latest' || !this.params.version) {
				return versions[0];
			}

			return semver.maxSatisfying(versions, this.params.version);
		});
	}

	async getMetadata () {
		return JSON.parse(await this.getMetadataAsJson());
	}

	async getMetadataAsJson () {
		let metadata = await redis.getAsync(this.keys.metadata);

		if (metadata) {
			return metadata;
		}

		metadata = JSON.stringify(await this.fetchMetadata(), null, '\t');
		await redis.setAsync(this.keys.metadata, metadata, 'EX', v1Config[this.params.type].maxAge);
		return metadata;
	}

	async handleResolveVersion () {
		try {
			this.ctx.body = { version: await this.getResolvedVersion() };
		} catch (e) {
			return this.responseNotFound();
		}
	}

	async handleVersions () {
		try {
			this.ctx.body = await this.getMetadataAsJson();
		} catch (e) {
			return this.responseNotFound();
		}
	}

	async handlePackageStats () {
		let data = await Package.getSumVersionHitsPerFileAndDateByName(this.params.name, ...this.dateRange);

		this.ctx.body = {
			total: sumDeep(data, 2),
			versions: _.mapValues(data, dates => ({ total: sumDeep(dates), dates })),
		};

		this.setCacheHeader();
	}

	async handleVersionFiles () {
		let metadata;

		try {
			metadata = await this.getMetadata();
		} catch (e) {
			return this.responseNotFound();
		}

		if (!metadata.versions.includes(this.params.version)) {
			return this.ctx.body = {
				status: 404,
				message: `Couldn't find version ${this.params.version} for ${this.params.name}. Make sure you use a specific version number, and not a version range or a tag.`,
			};
		}

		try {
			this.ctx.body = await this.getFiles(); // Can't use AsJson() version here because we need to set correct status code on cached errors.
			this.ctx.maxAge = v1Config.maxAgeStatic;
		} catch (error) {
			if (error instanceof got.ParseError/*error instanceof got.HTTPError*/) {
				return this.ctx.body = {
					status: error.response.statusCode || 502,
					message: error.response.body,
				};
			}

			throw error;
		}
	}

	async handleVersionStats () {
		let data = _.mapValues(await PackageVersion.findAllFileHitsByNameAndVersion(this.params.name, this.params.version, ...this.dateRange), (fileHits) => {
			let dates = _.fromPairs(_.map(fileHits, fileHits => [ fileHits.date.toISOString().substr(0, 10), fileHits.hits ] ));

			return {
				total: sumDeep(dates),
				dates,
			};
		});

		this.ctx.body = {
			total: sumDeep(data, 3),
			files: data,
		};

		this.setCacheHeader();
	}

	async responseNotFound () {
		this.ctx.body = {
			status: 404,
			message: `Couldn't find ${this.params.name}@${this.params.version}.`,
		};
	}
}

module.exports = PackageRequest;

/**
 * Fetches repo tags from GitHub.
 * @param {string} user
 * @param {string} repo
 * @return {Promise<Object>}
 */
async function fetchGitHubMetadata (user, repo) {
	let versions = [];
	let loadMore = (response) => {
		versions.push(..._.map(response.data, 'name'));

		if (response.data && githubApi.hasNextPage(response)) {
			return githubApi.getNextPage(response).then(loadMore);
		}

		return { tags: [], versions };
	};

	return githubApi.repos.getTags({ repo, owner: user, per_page: 100 }).then(loadMore).catch((err) => {
		if (err.code === 403) {
			logger.error({ err }, `GitHub API rate limit exceeded.`);
		}

		throw err;
	});
}

/**
 * Sends a query to all configured registries and returns the first response.
 * @param {string} name
 * @return {Promise<Object>}
 */
async function fetchNpmMetadata (name) {
	name = name.charAt(0) === '@' ? '@' + encodeURIComponent(name.substr(1)) : encodeURIComponent(name);
	let response;

	if (typeof v1Config.npm.sourceUrl === 'string') {
		response = await got(`${v1Config.npm.sourceUrl}/${name}`, { json: true, timeout: 30000 });
	} else {
		response = await Promise.any(_.map(v1Config.npm.sourceUrl, (sourceUrl) => {
			return got(`${sourceUrl}/${name}`, { json: true, timeout: 30000 });
		}));
	}

	if (!response.body || !response.body.versions) {
		throw new Error(`Unable to retrieve versions for package ${name}.`);
	}

	return {
		tags: response.body['dist-tags'],
		versions: Object.keys(response.body.versions).sort(semver.rcompare),
	};
}
