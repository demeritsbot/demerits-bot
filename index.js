var exec = require('child_process').exec;
var fs = require('fs');

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
    var output = [];
    for(var i = 0; i < split.length; i++) {
        var str = split[i];
        var str_split = str.substr(str.indexOf(':') + 1).split(':');
        if(str_split.length < 3)
            continue;
        str_split[0] = parseInt(str_split[0]);
        str_split[1] = parseInt(str_split[1]);
        str_split[2] = str_split[2].substr(1);
        output.push(str_split);
    }
    return output;
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

function cleanjshint(data) {
    var split = data.split("\n");
    var output = []
    for(var i = 0; i < split.length; i++) {
        var str = split[i];
        console.log(str);
        var cio = str.indexOf(': ');
        if(cio == -1)
            continue;
        var str_split = str.substr(cio + 2).split(', ');
        str_split[0] = parseInt(str_split[0].substr(5));
        str_split[1] = parseInt(str_split[1].substr(4));
        console.log(str_split);
        output.push(str_split);
    }
    return output;
}

function jshintData(data, callback) {
    temp.open('jshint', function(err, info) {
        fs.write(info.fd, data);
        fs.close(info.fd, function(err) {
            var command = "jshint '" + info.path + "'";
            console.log(command);
            exec(command, function(err, stdout, stderr) {
                callback(
                    stdout.split("\n").length,
                    cleanjshint(stdout)
                );
            });
        });
    });
}

extmap = {
    '.py': flakeData,
    '.js': jshintData
}

function getNewOutput(oldout, newout) {
    if(oldout.length == 0)
        return newout;
    if(newout.length == 0)
        return [];

    function p_eq(i, j) {
        if(oldout[i][0] < newout[j][0])
            return -1;
        else if (oldout[i][0] > newout[j][0])
            return 1;
        if(oldout[i][1] < newout[j][1])
            return -1;
        else if (oldout[i][1] > newout[j][1])
            return 1;
        return 0;
    }
    // i == pointer in old output
    var i = 0;
    // j == pointer in new output
    var j = 0;
    var result = [];
    for(j = 0; j < newout.length; j++) {
        var e = p_eq(i, j);
        if(e == -1) {
            result.push(newout[j]);
            continue;
        }
        if(e == 0) {
            i++;
            continue;
        }
        if(e == 1) {
            j++;
            i--;
            continue;
        }
    }
    return result;
}

function process(owner, repo, sha, say) {
    console.log(owner, repo, sha);
    gh.repos.getCommit(
        {user: owner, repo: repo, sha: sha},
        function(error, data) {
            if(error) {
                console.error(error);
                say('There was an error fetching that commit.');
                say(error.message);
            }
            var victim = data.committer.login;
            var parent_commit = data.parents[0].sha;
            console.log("sha: " + sha);
            console.log("parent: " + parent_commit);
            var files = [];
            var total_demerits = 0;
            var dem_ops = 0;
            for(var f in data.files) {
                var path = data.files[f].filename;
                var ext = path.substr(path.length - 3);

                if(!(ext in extmap)) {
                    continue;
                }
                var processor = extmap[ext];

                files.push(path);
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

                            var dres = getNewOutput(bflak, aflak);
                            for(var d in dres) {
                                say(dres[d][2]);
                                gh.authenticate({
                                    type: 'basic',
                                    username: settings.gh_user,
                                    password: settings.gh_pass
                                });
                                // Comment on the line in the commit.
                                gh.repos.createCommitComment(
                                    {user: owner, repo: repo, sha: sha, commit_id: sha,
                                     body: dres[d][2], path: path, line: dres[d][0]},
                                    function(err, data) {}
                                );
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
                               say("The work is satisfactory.");
                        }
                    }
                    gh.repos.getContent(
                        {user: owner, repo: repo, ref: parent_commit, path: path},
                        function(error, data) {
                            if(error) {
                                console.log(error);
                                before = '';
                                beforeFlakes = 0;
                                bflak = [];
                                handle();
                                return;
                            }
                            console.log("Downloaded " + path + " before");
                            before = new Buffer(data.content, 'base64').toString('ascii');
                            processor(before, function(lines, output) {
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
                            if(error) {
                                console.log(error);
                                after = '';
                                afterFlakes = 0;
                                aflak = [];
                                handle();
                                return;
                            }
                            if(error)
                                console.log(error);
                            console.log("Downloaded " + path + " after");
                            after = new Buffer(data.content, 'base64').toString('ascii');
                            processor(after, function(lines, output) {
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

    if(settings.github_users.length && settings.github_users.indexOf(owner) == -1)
        return;
    if(settings.github_repos.length && settings.github_repos.indexOf(repo) == -1)
        return;

    if(from == ghbot)
        client.say(to, "[" + sha.substr(0, 7) + "] Imma just have a look at that...");
    else
        client.say(to, from + ": I'll take a look.");

    process(owner, repo, sha, function(message) {
        client.say(to, message);
    });

});
