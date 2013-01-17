var exec = require('child_process').exec;
var fs = require('fs');

var diff = require('diff');
var github = require('github');
var irc = require('irc');
var temp = require('temp');

var settings = require('./settings');

var client = new irc.Client(settings.irc_server, 'demerits', {
    channels: settings.irc_channels,
});

var gh = new github({
    // required
    version: "3.0.0",
    // optional
    timeout: 3000
});

var ghbot = "github";
var commit_match = /https:\/\/github.com\/([a-z0-9\-]+)\/([a-z0-9\-]+)\/commit\/([a-z0-9]+)/i;


function cleanpep8(data) {
    var split = data.split("\n");
    for(var i = 0; i < split.length; i++) {
        var str = split[i];
        split[i] = str.substr(str.indexOf(':') + 1);
    }
    return split.join("\n");
}

function flakeData(data, callback) {
    temp.open('flake', function(err, info) {
        fs.write(info.fd, data);
        fs.close(info.fd, function(err) {
            var command = "pep8 --first '" + info.path + "'";
            console.log(command);
            exec(command, function(err, stdout, stderr) {
                callback(
                    stdout.split("\n").length,
                    cleanpep8(stdout)
                );
            });
        });
    });
}

function process(owner, repo, sha, say) {
    console.log(owner, repo, sha);
    gh.repos.getCommit(
        {user: owner, repo: repo, sha: sha},
        function(error, data) {
            if(error)
                console.error(error);
            var victim = data.committer.login;
            var parent_commit = data.parents[0].sha;
            console.log("sha: " + sha);
            console.log("parent: " + parent_commit);
            var files = [];
            var total_demerits = 0;
            var dem_ops = 0;
            for(var f in data.files) {
                var path = data.files[f].filename;
                files.push(path);
                if(path.substr(path.length - 3) != ".py") continue;
                dem_ops++;
                (function(path) {
                    var before, after,
                        beforeFlakes, afterFlakes,
                        bflak, aflak;
                    function handle() {
                        if(beforeFlakes === undefined || afterFlakes === undefined)
                            return;

                        console.log("FINAL: " + path + " :: " + afterFlakes + "/" + beforeFlakes);

                        if(afterFlakes > beforeFlakes) {
                            var dems = afterFlakes - beforeFlakes;
                            say("[" + path + "] " + dems + " demerits!");
                            total_demerits += dems;

                            var dres = diff.diffLines(bflak, aflak);
                            for(var d in dres) {
                                var df = dres[d];
                                if(df.added) {
                                   say(df.value);
                                }
                            }

                            gh.authenticate({
                                type: 'basic',
                                username: settings.gh_user,
                                password: settings.gh_pass
                            });
                            // Comment and say how many demerits the commit was worth.
                            gh.repos.createCommitComment(
                                {user: owner, repo: repo, sha: sha, commit_id: sha,
                                 body: dems + " demerits!"},
                                function(err, data) {}
                            );
                        }
                        dem_ops--;
                        if(dem_ops == 0) {
                            if(total_demerits)
                               say(victim + " racked up " + total_demerits + " demerits. Unsatisfactory.");
                            else
                               say(victim + "'s work is satisfactory.");
                        }
                    }
                    gh.repos.getContent(
                        {user: owner, repo: repo, ref: parent_commit, path: path},
                        function(error, data) {
                            if(error)
                                console.log(error);
                            console.log("Downloaded " + path + " before");
                            before = new Buffer(data.content, 'base64').toString('ascii');
                            flakeData(before, function(lines, output) {
                                console.log(path + " before: " + lines + "\n" + output);
                                beforeFlakes = lines;
                                bflak = output;
                                handle();
                            });
                        }
                    );
                    gh.repos.getContent(
                        {user: owner, repo: repo, ref: sha, path: path},
                        function(error, data) {
                            if(error)
                                console.log(error);
                            console.log("Downloaded " + path + " after");
                            after = new Buffer(data.content, 'base64').toString('ascii');
                            flakeData(after, function(lines, output) {
                                console.log(path + " after: " + lines + "\n" + output);
                                afterFlakes = lines;
                                aflak = output;
                                handle();
                            });
                        }
                    );

                })(path);
            }

            if(files.length == 0) {
                say("[" + sha + "] There weren't any files I could understand.")
            }
        }
    );
}


client.addListener('message', function(from, to, message) {
    var result = commit_match.exec(message);
    if (result === null)
        return;

    var owner = result[1];
    var repo = result[2];
    var sha = result[3];

    if(settings.github_owners && settings.github_owners.indexOf(owner) == -1)
        return;
    if(settings.github_repos && settings.github_repos.indexOf(repo) == -1)
        return;

    if(from == ghbot)
        client.say(to, "[" + sha.substr(0, 7) + "] Imma just have a look at that...");
    else
        client.say(to, from + ": I'll take a look.");

    process(owner, repo, sha, function(message) {
        client.say(to, message);
    });

});
