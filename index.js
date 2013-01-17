var irc = require('irc');
var github = require('github');
var exec = require('child_process').exec;
var fs = require('fs');
var temp = require('temp');
var diff = require('diff');

var client = new irc.Client('irc.mozilla.org', 'demerits', {
    channels: ['#dangerzone', '#amo-bots'],
});

var gh = new github({
    // required
    version: "3.0.0",
    // optional
    timeout: 3000
});

var ghbot = "github";
var commit_match = /https:\/\/github.com\/mozilla\/zamboni\/commit\/([a-z0-9]+)$/;

function flakeData(data, callback) {
    temp.open('flake', function(err, info) {
        fs.write(info.fd, data);
        fs.close(info.fd, function(err) {
            var command = "pep8 '" + info.path + "'";
            console.log(command);
            exec(command, function(err, stdout, stderr) {
                callback(stdout.split("\n").length, stdout);
            });
        });
    });
}


client.addListener('message', function(from, to, message) {
    if(from != ghbot)
        return;

    var result = commit_match.exec(message);
    if (!result || !result[1])
        return;

    var sha = result[1];
    gh.repos.getCommit(
        {user: 'mozilla', repo: 'zamboni', sha: sha},
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
                    var before, after, beforeFlakes, afterFlakes, bflak, aflak;
                    function handle() {
                        if(beforeFlakes === undefined || afterFlakes === undefined)
                            return;

                        console.log("FINAL: " + path + " :: " + afterFlakes + "/" + beforeFlakes);

                        if(afterFlakes > beforeFlakes) {
                            var dems = afterFlakes - beforeFlakes;
                            client.say(to, "[" + path + "] " + dems + " demerits!");
                            total_demerits += dems;

                            var dres = diff.diffLines(bflak, aflak);
                            for(var d in dres) {
                                var df = dres[d];
                                if(victim == "mattbasta" && df.added) {
                                    client.say(to, df.value);
                                }
                            }
                        }
                        dem_ops--;
                        if(dem_ops == 0) {
                            if(total_demerits)
                                client.say(to, victim + " racked up " + total_demerits + " demerits. Unsatisfactory.");
                            else
                                client.say(to, victim + "'s work is satisfactory.");
                        }
                    }
                    gh.repos.getContent(
                        {user: 'mozilla', repo: 'zamboni', ref: parent_commit, path: path},
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
                        {user: 'mozilla', repo: 'zamboni', ref: sha, path: path},
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
            //client.say(to, files.join("\n"));
        }
    );

    client.say(to, "[" + result[1].substr(0, 7) + "] Imma just have a look at that...");

});
